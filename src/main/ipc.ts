import { safeExternalLink } from '../shared/external-link.js';
import { REASONING_EFFORTS } from '../shared/session.js';
import { localIpcAllowed } from './local-policy.js';
import { registerPluginIpc } from './plugins-ipc.js';
import { titleBarOverlayForTheme, UI_BASE_ZOOM } from './window-layout.js';
import { applyLoginStartup, supportsLoginStartup } from './window-lifecycle.js';
/**
 * IPC surface.
 *
 * A fixed list of named handlers, each validating its own input with zod. There is no
 * generic "call this method" or "read this file" channel, so a compromised renderer
 * gains only the operations listed below — it can never reach the filesystem or spawn
 * a process directly. Secrets travel one way: the renderer can set or clear the API
 * key but can never read it back.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { z } from 'zod';
import { MAX_GOAL_SYSTEM_PROMPT_CHARS } from '../shared/goal.js';
import {
CAPABILITIES,
CHAT_BROWSERS,
GOAL_MODES,
GOAL_PROVIDERS,
GOAL_REASONING_LEVELS,
type AppState,
type Config
} from '../shared/types.js';
import {
getMacOSDesktopAccess,
onMacOSDesktopAccessChange,
refreshMacOSDesktopAccess
} from './computer/index.js';
import { effectiveCapabilities, getConfig, MAX_MCP_INSTRUCTIONS_CHARS, updateConfig } from './config.js';
import { applySettings, connect, disconnect, getStatus, onStatusChange } from './connection.js';
import { runDiagnostics } from './diagnostics.js';
import { formatLogAsJson, formatLogForClipboard, getLog, logInfo, onLog } from './logger.js';
import { forgetExposedSurface } from './mcp/server.js';
import { hostPlatformInfo } from './platform.js';
import { RESERVED_ROOT_NAMES, SandboxError, uniqueRootName, validateNewRoot } from './sandbox.js';
import { hasSecret, isEncryptionAvailable, secureStorageStatus, setSecret } from './secrets.js';
import { TUNNEL_ID_PATTERN } from './tunnel/index.js';
import { bundledVersion, locateBinary } from './tunnel/locate.js';
import { updateStatus } from './update.js';
import { forgetWorkspaceRoot, renameWorkspaceRoot } from './workspace.js';

/** Fixed native Settings destinations; authored chat links use the shared web/mail policy. */
const ALLOWED_LINKS = new Set([
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
]);

const capabilityPatch = z.object(
  Object.fromEntries(CAPABILITIES.map((c) => [c, z.boolean()])) as Record<
    (typeof CAPABILITIES)[number],
    z.ZodBoolean
  >
);

const settingsPatch = z.object({
  capabilities: capabilityPatch,
  readOnly: z.boolean(),
  tunnel: z.object({
    pluginsTunnelId: z.string().max(128).refine(v => v === '' || TUNNEL_ID_PATTERN.test(v), 'Expected tunnel_ followed by 32 hex characters').optional(),
    kind: z.enum(['openai', 'cloudflared', 'manual']),
    tunnelId: z
      .string()
      .max(128)
      .refine((v) => v === '' || TUNNEL_ID_PATTERN.test(v), 'Expected tunnel_ followed by 32 hex characters'),
    // The Desktop connector's own tunnel. Empty is normal and means "not published":
    // Desktop is optional, and most users will never create a second Secure Tunnel.
    desktopTunnelId: z
      .string()
      .max(128)
      .refine((v) => v === '' || TUNNEL_ID_PATTERN.test(v), 'Expected tunnel_ followed by 32 hex characters'),
    binaryPath: z.string().max(4096)
  }),
  ui: z.object({
    chatBrowser: z.enum(CHAT_BROWSERS).optional(),
    developerMode: z.boolean().optional(),
    finishTool: z.boolean().optional(),
    planBackend: z.enum(['chatgpt', 'api']).optional(),
    finishAction: z.enum(['notify', 'goal']).optional(),
    finishLeadMinutes: z.number().int().min(3).max(5).optional(),
    backgroundChats: z.boolean().optional(),
    browserOnly: z.boolean().optional(),
    autoRefreshPlugins: z.boolean().optional(),
    tabsToKeepOpen: z.number().int().min(1).max(50).optional(),
    minimizeToTray: z.boolean(),
    autoConnect: z.boolean(),
    startAtLogin: z.boolean().optional(),
    privacyScreenshots: z.boolean(),
    theme: z.enum(['light', 'dark'])
  }),
  sessions: z.object({
    record: z.boolean(),
    retainDays: z.number().int().min(0).max(3650),
    advisoryTokens: z.number().int().min(10_000).max(4_000_000),
    limitTokens: z.number().int().min(10_000).max(4_000_000)
  }),
  compaction: z.object({
    auto: z.boolean(),
    // Floored well above what a fresh chat holds, so a threshold cannot be set somewhere
    // every conversation is already past the moment it opens.
    autoTokens: z.number().int().min(10_000).max(4_000_000)
  }),
  multiAgent: z.object({
    enabled: z.boolean(),
    defaultModel: z.string().max(80).optional(),
    defaultReasoning: z.enum(['', ...REASONING_EFFORTS]).optional(),
    maxWorkers: z.number().int().min(1).max(8),
    allowUnattributedCalls: z.boolean(),
    recoverAgentTabs: z.boolean()
  }),
  mcp: z.object({ instructions: z.string().trim().max(MAX_MCP_INSTRUCTIONS_CHARS) }).strict().optional(),
  goal: z.object({
    impulseMinutes: z.number().int().min(0).max(60).optional(),
    includeToolCalls: z.boolean().optional(),
      backend: z.enum(['api', 'chatgpt', 'templates']).optional(),
      loopBackend: z.enum(['api', 'chatgpt']).optional(),
      helperModel: z.string().trim().min(1).max(80).optional(),
      helperReasoning: z.enum(REASONING_EFFORTS).optional(),
    enabled: z.boolean(),
    // Which of the two standing modes the switch runs. One field, so the renderer has no way
    // to describe a state where Goal and Loop are both on.
    mode: z.enum(GOAL_MODES),
    // Which LLM endpoint Goal/Loop drafts run on, plus the custom endpoint's base URL.
    // The URL is stored verbatim and validated at draft time (see resolveGoalBaseUrl):
    // a shape check here would either duplicate that logic or silently rewrite the address.
    provider: z.object({
      kind: z.enum(GOAL_PROVIDERS),
      baseUrl: z.string().max(2048)
    }),
    // An OpenRouter model id while the provider is openrouter, validated only as a shape:
    // the catalogue changes weekly, and an allow-list here would mean this app deciding
    // which models exist.
    // The leading `~` is OpenRouter's own marker for an alias that always resolves to the
    // newest model in a family — `~deepseek/deepseek-v4-flash-latest` and eleven others. The
    // picker lists them because the listing does, so refusing them here meant the one kind
    // of entry most worth choosing was the one kind that could not be saved.
    // A custom endpoint names its own models (`llama3.1`, a deployment id), so while custom
    // it is any non-empty id instead.
    model: z.string().min(1).max(160),
    reasoning: z.enum(GOAL_REASONING_LEVELS),
    prompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS),
    objectivePrompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS),
    loopPrompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
  }).superRefine((goal, ctx) => {
    if (goal.provider.kind !== 'custom' && !/^~?[a-z0-9._-]+\/[a-z0-9._-]+(:[a-z0-9._-]+)?$/i.test(goal.model)) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'Expected an OpenRouter model id like vendor/model'
      });
    }
  })
});

const settingsSave = z.object({ base: settingsPatch, patch: settingsPatch }).strict();
type SettingsSnapshot = z.infer<typeof settingsPatch>;

/**
 * Three-way merge for the renderer's settings form.
 *
 * The Chrome extension is a second writer for Goal/Auto Compact. The renderer previously sent
 * a blind full snapshot for every checkbox/theme edit, so a snapshot captured just before an
 * extension write could land just after it and silently undo that newer value. A field which is
 * unchanged between `base` and `wanted` was not edited by this renderer save and therefore keeps
 * the current main-process value. A field that differs was deliberately edited here and wins.
 */
function mergeSettings(current: Config, base: SettingsSnapshot, wanted: SettingsSnapshot): SettingsSnapshot {
  const pick = <T>(live: T, before: T, next: T): T => (Object.is(before, next) ? live : next);
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      pick(current.capabilities[capability], base.capabilities[capability], wanted.capabilities[capability])
    ])
  ) as Config['capabilities'];
  return {
    mcp: wanted.mcp ? { instructions: pick(current.mcp.instructions, base.mcp?.instructions ?? '', wanted.mcp.instructions) } : current.mcp,
    capabilities,
    readOnly: pick(current.readOnly, base.readOnly, wanted.readOnly),
    tunnel: {
        pluginsTunnelId: wanted.tunnel.pluginsTunnelId === undefined ? current.tunnel.pluginsTunnelId ?? ''
          : pick(current.tunnel.pluginsTunnelId ?? '', base.tunnel.pluginsTunnelId ?? '', wanted.tunnel.pluginsTunnelId),
      kind: pick(current.tunnel.kind, base.tunnel.kind, wanted.tunnel.kind),
      tunnelId: pick(current.tunnel.tunnelId, base.tunnel.tunnelId, wanted.tunnel.tunnelId),
      desktopTunnelId: pick(
        current.tunnel.desktopTunnelId,
        base.tunnel.desktopTunnelId,
        wanted.tunnel.desktopTunnelId
      ),
      binaryPath: pick(current.tunnel.binaryPath, base.tunnel.binaryPath, wanted.tunnel.binaryPath)
    },
    ui: {
      chatBrowser: pick(current.ui.chatBrowser, base.ui.chatBrowser, wanted.ui.chatBrowser),
      developerMode: pick(current.ui.developerMode, base.ui.developerMode, wanted.ui.developerMode),
      finishTool: pick(current.ui.finishTool, base.ui.finishTool, wanted.ui.finishTool),
      planBackend: pick(current.ui.planBackend, base.ui.planBackend, wanted.ui.planBackend),
      finishAction: pick(current.ui.finishAction, base.ui.finishAction, wanted.ui.finishAction),
      finishLeadMinutes: pick(current.ui.finishLeadMinutes, base.ui.finishLeadMinutes, wanted.ui.finishLeadMinutes),
      backgroundChats: pick(current.ui.backgroundChats, base.ui.backgroundChats, wanted.ui.backgroundChats),
      browserOnly: pick(current.ui.browserOnly, base.ui.browserOnly, wanted.ui.browserOnly),
      autoRefreshPlugins: pick(current.ui.autoRefreshPlugins, base.ui.autoRefreshPlugins, wanted.ui.autoRefreshPlugins),
      tabsToKeepOpen: pick(current.ui.tabsToKeepOpen, base.ui.tabsToKeepOpen, wanted.ui.tabsToKeepOpen),
      minimizeToTray: pick(current.ui.minimizeToTray, base.ui.minimizeToTray, wanted.ui.minimizeToTray),
      autoConnect: pick(current.ui.autoConnect, base.ui.autoConnect, wanted.ui.autoConnect),
      startAtLogin: pick(current.ui.startAtLogin, base.ui.startAtLogin, wanted.ui.startAtLogin),
      privacyScreenshots: pick(
        current.ui.privacyScreenshots,
        base.ui.privacyScreenshots,
        wanted.ui.privacyScreenshots
      ),
      theme: pick(current.ui.theme, base.ui.theme, wanted.ui.theme)
    },
    sessions: {
      record: pick(current.sessions.record, base.sessions.record, wanted.sessions.record),
      retainDays: pick(current.sessions.retainDays, base.sessions.retainDays, wanted.sessions.retainDays),
      advisoryTokens: pick(
        current.sessions.advisoryTokens,
        base.sessions.advisoryTokens,
        wanted.sessions.advisoryTokens
      ),
      limitTokens: pick(current.sessions.limitTokens, base.sessions.limitTokens, wanted.sessions.limitTokens)
    },
    compaction: {
      auto: pick(current.compaction.auto, base.compaction.auto, wanted.compaction.auto),
      autoTokens: pick(current.compaction.autoTokens, base.compaction.autoTokens, wanted.compaction.autoTokens)
    },
    multiAgent: {
      defaultModel: pick(current.multiAgent.defaultModel, base.multiAgent.defaultModel, wanted.multiAgent.defaultModel),
      defaultReasoning: pick(current.multiAgent.defaultReasoning, base.multiAgent.defaultReasoning, wanted.multiAgent.defaultReasoning),
      enabled: pick(current.multiAgent.enabled, base.multiAgent.enabled, wanted.multiAgent.enabled),
      maxWorkers: pick(current.multiAgent.maxWorkers, base.multiAgent.maxWorkers, wanted.multiAgent.maxWorkers),
      allowUnattributedCalls: pick(
        current.multiAgent.allowUnattributedCalls,
        base.multiAgent.allowUnattributedCalls,
        wanted.multiAgent.allowUnattributedCalls
      ),
      recoverAgentTabs: pick(
        current.multiAgent.recoverAgentTabs,
        base.multiAgent.recoverAgentTabs,
        wanted.multiAgent.recoverAgentTabs
      )
    },
    goal: {
      impulseMinutes: pick(current.goal.impulseMinutes, base.goal.impulseMinutes, wanted.goal.impulseMinutes),
      includeToolCalls: pick(current.goal.includeToolCalls, base.goal.includeToolCalls, wanted.goal.includeToolCalls),
      backend: pick(current.goal.backend, base.goal.backend, wanted.goal.backend),
      loopBackend: pick(current.goal.loopBackend, base.goal.loopBackend, wanted.goal.loopBackend),
      helperModel: pick(current.goal.helperModel, base.goal.helperModel, wanted.goal.helperModel),
      helperReasoning: pick(current.goal.helperReasoning, base.goal.helperReasoning, wanted.goal.helperReasoning),
      enabled: pick(current.goal.enabled, base.goal.enabled, wanted.goal.enabled),
      mode: pick(current.goal.mode, base.goal.mode, wanted.goal.mode),
      provider: {
        kind: pick(current.goal.provider.kind, base.goal.provider.kind, wanted.goal.provider.kind),
        baseUrl: pick(current.goal.provider.baseUrl, base.goal.provider.baseUrl, wanted.goal.provider.baseUrl)
      },
      model: pick(current.goal.model, base.goal.model, wanted.goal.model),
      reasoning: pick(current.goal.reasoning, base.goal.reasoning, wanted.goal.reasoning),
      prompt: pick(current.goal.prompt, base.goal.prompt, wanted.goal.prompt),
      objectivePrompt: pick(
        current.goal.objectivePrompt,
        base.goal.objectivePrompt,
        wanted.goal.objectivePrompt
      ),
      loopPrompt: pick(current.goal.loopPrompt, base.goal.loopPrompt, wanted.goal.loopPrompt)
    }
  };
}

const renameRoot = z.object({
  name: z.string().min(1).max(32),
  newName: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Lowercase letters, digits, dot, dash and underscore only')
});

function resolvedBinary(config: Config): string | null {
  if (config.tunnel.kind === 'cloudflared') return locateBinary('cloudflared', config.tunnel.binaryPath);
  if (config.tunnel.kind === 'openai') return locateBinary('tunnel-client', config.tunnel.binaryPath);
  return null;
}

async function buildState(): Promise<AppState> {
  const config = getConfig();
  return {
    config,
    status: getStatus(),
    platform: hostPlatformInfo(),
    loginStartupAvailable: supportsLoginStartup(process.platform, app.isPackaged),
    secureStorage: await secureStorageStatus(),
    hasApiKey: await hasSecret('openaiApiKey'),
    hasGoalKey: await hasSecret('openRouterApiKey'),
    hasCustomProviderKey: await hasSecret('customProviderApiKey'),
    resolvedBinary: resolvedBinary(config),
    bundledTunnelVersion: bundledVersion(),
    bridge: { running: false, port: null, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: updateStatus(),
    desktopAccess: getMacOSDesktopAccess()
  };
}

/** Wraps a handler so a thrown error becomes a message the UI can show. */
function handle<T>(channel: string, fn: (payload: unknown) => Promise<T>): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      if (!localIpcAllowed(channel)) throw new Error('This action is not available in the Local edition.');
      return { ok: true as const, data: await fn(payload) };
    } catch (err) {
      const message =
        err instanceof SandboxError || err instanceof z.ZodError
          ? err instanceof z.ZodError
            ? (err.issues[0]?.message ?? 'Invalid input')
            : err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false as const, error: message };
    }
  });
}

export function registerIpc(getWindow: () => BrowserWindow | null, _quitToInstall: () => void): void {
  registerPluginIpc(handle, getWindow);
  handle('state:get', async () => {
    const state = await buildState();
    // Native package smoke uses this as the end-to-end renderer readiness barrier. Unlike
    // `did-finish-load`, it can only happen after the renderer's first IPC request has completed
    // secure-storage availability/decryption probes and the rest of the initial state snapshot.
    logInfo('renderer state ready');
    return state;
  });

  handle('settings:save', async (payload) => {
    const request = settingsSave.parse(payload);
    const before = getConfig();
    const next = await updateConfig(config => ({ ...config, ...mergeSettings(config, request.base, request.patch) }));
    // Renderer palette changes are immediate, so keep OS/Electron-owned chrome in lock-step too.
    // Without this, selecting Dark on macOS left the title bar, menus and file picker in the
    // system theme until restart (and startup still defaulted to system before index.ts applies it).
    nativeTheme.themeSource = next.ui.theme;
    if (process.platform === 'win32') getWindow()?.setTitleBarOverlay(titleBarOverlayForTheme(next.ui.theme));
    // BrowserWindow's native backing color is fixed at construction unless updated explicitly.
    // Keep it in lock-step too: the default macOS application menu exposes Reload, and after a
    // live theme switch an old opposite background otherwise flashes behind the renderer while it
    // paints again. This is also the color Electron shows during any later renderer reload/failure.
    getWindow()?.setBackgroundColor(next.ui.theme === 'dark' ? '#0e0e11' : '#ffffff');
    // Explicit settings changes replace discovery's monotonic snapshot. Otherwise
    // disabled permissions/finish/session tools remain published and no schema change
    // reaches automatic plugin refresh. Cosmetic saves must not invalidate discovery.
    if (before.multiAgent.enabled !== next.multiAgent.enabled || before.sessions.record !== next.sessions.record ||
        before.ui.finishTool !== next.ui.finishTool ||
        JSON.stringify(effectiveCapabilities(before)) !== JSON.stringify(effectiveCapabilities(next))) forgetExposedSurface();
    // Permissions and the second tunnel id both decide whether the optional Desktop
    // connector should be published. Without this, enabling desktop access or pasting its
    // tunnel id left the connector unpublished until the user happened to reconnect, with
    // the card still saying "not published" and nothing explaining why.
    await applySettings();

    logInfo('settings updated');
    // The config and runtime side effects above still complete so the app does not stay half-on,
    // but the UI must not be told the pause was safely accepted when its retained authority
    // snapshot failed to cross disk. Startup with the feature off restores and canonicalizes
    // that same history instead of deleting it.
    // Login registration is an independent OS preference. Cosmetic saves do not rewrite
    // it, and its failure cannot interrupt permission publication or Goal/worker teardown.
    let loginStartupError: unknown;
    if ((before.ui.startAtLogin === true) !== (next.ui.startAtLogin === true)) {
      try { applyLoginStartup(app, next.ui.startAtLogin === true); }
      catch (error) { loginStartupError = error; }
    }

    if (loginStartupError) throw loginStartupError;
    return buildState();
  });

  /** Approves one folder by path. The picker dialog and the drop zone both end here. */
  const approveRoot = async (folderPath: string): Promise<AppState> => {
    let addedName = '';
    await updateConfig(async (config) => {
      const real = await validateNewRoot(folderPath, config.roots);
      const name = uniqueRootName(real, config.roots);
      addedName = name;
      return { ...config, roots: [...config.roots, { name, path: real }] };
    });
    logInfo(`approved folder /${addedName}`);
    return buildState();
  };

  handle('roots:add', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, {
      title: 'Approve a folder for ChatGPT',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return buildState();
    return approveRoot(result.filePaths[0]);
  });

  // A folder dropped onto the Folders card. The renderer never sees a system path itself:
  // the preload turns the dropped File into one, and the same validation the dialog goes
  // through decides whether it is a folder this app may approve at all.
  handle('roots:addPath', async (payload) => {
    const { path: folderPath } = z.object({ path: z.string().min(1).max(4096) }).parse(payload);
    return approveRoot(folderPath);
  });

  handle('roots:remove', async (payload) => {
    const { name } = z.object({ name: z.string().min(1).max(32) }).parse(payload);
    await updateConfig((config) => {
      if (!config.roots.some((root) => root.name === name)) throw new Error(`/${name} is not an approved folder`);
      return {
        ...config,
        roots: config.roots.filter((r) => r.name !== name)
      };
    });
    forgetWorkspaceRoot(name);
    logInfo(`removed folder /${name}`);
    return buildState();
  });

  handle('roots:rename', async (payload) => {
    const { name, newName } = renameRoot.parse(payload);
    if (RESERVED_ROOT_NAMES.has(newName)) {
      throw new SandboxError(`/${newName} is reserved by Chat On Steroids and cannot be used as a folder name`);
    }
    await updateConfig((config) => {
      if (!config.roots.some((root) => root.name === name)) throw new Error(`/${name} is not an approved folder`);
      if (config.roots.some((r) => r.name !== name && r.name === newName)) {
        throw new Error(`/${newName} is already used`);
      }
      return {
        ...config,
        roots: config.roots.map((r) => (r.name === name ? { ...r, name: newName } : r))
      };
    });
    renameWorkspaceRoot(name, newName);
    return buildState();
  });

  /**
   * Stores one of the defined provider keys by name.
   *
   * The name is an enum rather than a string, so the renderer can choose *which* credential
   * it is writing but cannot name a slot nobody defined — and the value still only ever
   * travels inwards. Nothing reads a key back out over IPC; the state carries a boolean.
   */
  handle('secret:set', async (payload) => {
    const { value, key } = z
      .object({
        value: z.string().max(500),
        key: z.enum(['openaiApiKey']).default('openaiApiKey')
      })
      .parse(payload);
    if (!(await isEncryptionAvailable())) {
      throw new Error('Secure OS credential storage is unavailable, so the key cannot be stored safely.');
    }
    await setSecret(key, value);
    logInfo(value.trim() === '' ? 'api key cleared' : 'api key stored');
    return buildState();
  });

  handle('binary:pick', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, {
      title: 'Select the tunnel executable',
      properties: ['openFile'],
      ...(process.platform === 'win32' ? { filters: [{ name: 'Programs', extensions: ['exe'] }] } : {})
    });
    if (result.canceled || !result.filePaths[0]) return buildState();
    await updateConfig((config) => ({
      ...config,
      tunnel: { ...config.tunnel, binaryPath: result.filePaths[0]! }
    }));
    // This is a Core transport setting just like changing the method/tunnel id in the form.
    // Apply it immediately when connected rather than saving a path the running child never
    // uses until some unrelated future reconnect.
    await applySettings();
    return buildState();
  });

  handle('connection:connect', async () => {
    await connect();
    return buildState();
  });

  handle('connection:disconnect', async () => {
    await disconnect();
    return buildState();
  });

  handle('diagnostics:run', async () => runDiagnostics());
  handle('desktop:requestAccessibility', async () => {
    await refreshMacOSDesktopAccess({ promptAccessibility: true });
    return buildState();
  });

  handle('log:get', async () => getLog());
  handle('log:text', async () => formatLogForClipboard());
  handle('log:json', async () => formatLogAsJson());
  handle('clipboard:write', async (payload) => {
    const { text } = z.object({ text: z.string().max(1_000_000) }).parse(payload);
    clipboard.writeText(text);
    return true;
  });

  handle('link:open', async (payload) => {
    const { url } = z.object({ url: z.string().max(8192) }).parse(payload);
    if (!ALLOWED_LINKS.has(url) && !safeExternalLink(url)) throw new Error('That link is not allowed');
    await shell.openExternal(url);
    return true;
  });
  handle('window:getZoom', async () => (getWindow()?.webContents.getZoomFactor() ?? UI_BASE_ZOOM) / UI_BASE_ZOOM);
  handle('window:zoom', async (payload) => {
    const { factor } = z.object({ factor: z.number().min(0.75).max(1.5) }).parse(payload);
    getWindow()?.webContents.setZoomFactor(factor * UI_BASE_ZOOM);
    return factor;
  });


  // Push updates so the UI reflects tunnel progress without polling. buildState() crosses
  // async secret/bridge reads, so an older snapshot can otherwise resolve after a newer one and
  // repaint stale config/status. Latest-request-wins makes the push stream monotonic.
  /**
   * Sends to the renderer, if there still is one.
   *
   * A null window was always handled; a *destroyed* one was not. Electron keeps the object
   * alive after the window is gone, so `getWindow()` stays truthy and merely reading
   * `.webContents` off it throws. That is not just a missed repaint: `onLog` runs inside
   * `log()`, synchronously, on the caller's own stack — so once the window was destroyed,
   * every log line written during teardown threw into whatever was writing it. The MCP drain's
   * force-close timer died on its own `logWarn` before it could force anything, and the app
   * sat draining a half-closed tunnel socket forever, with no window, no tray, and the
   * single-instance lock still held.
   */
  const push = (channel: string, ...args: unknown[]): void => {
    const target = getWindow();
    if (!target || target.isDestroyed()) return;
    target.webContents.send(channel, ...args);
  };
  let statePushGeneration = 0;
  const pushState = (): void => {
    const generation = ++statePushGeneration;
    void buildState().then((state) => {
      if (generation !== statePushGeneration) return;
      push('state:changed', state);
    });
  };
  onStatusChange(pushState);
  // Draft stages belong to session controls; state:changed only refreshes settings.
  onMacOSDesktopAccessChange(pushState);
  onLog((entry) => push('log:entry', entry));
}
