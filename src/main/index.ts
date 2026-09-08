/**
 * Main process entry: window, tray, and the security posture for the renderer.
 */

import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen, session, Tray } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { unifiedExecManager } from './codex/manager.js';
import { stopComputerHelper } from './computer/index.js';
import { getConfig, initConfigPath, loadConfig, updateConfig } from './config.js';
import { connect, disconnect, getStatus, onStatusChange, shutdownConnection } from './connection.js';
import { flushDurable, initDurableStore } from './durable.js';
import { editContextMenuTemplate } from './edit-context-menu.js';
import { registerIpc } from './ipc.js';
import { initLogFile, logError, logInfo, logWarn } from './logger.js';
import { pluginManager } from './plugins/manager.js';
import { uniqueRootName, validateNewRoot } from './sandbox.js';
import { initSecretsPath, setSecret } from './secrets.js';
import { initSessionStore } from './session/store.js';
import { runShutdownSequence } from './shutdown.js';
import { trayGuidArgsForPlatform, trayImageSpec } from './tray-image.js';
import { browserWindowIconPath } from './window-icon.js';
import { titleBarOverlayForTheme, UI_BASE_ZOOM, windowLayoutForWorkArea } from './window-layout.js';
import {
applyLoginStartup,
createWindowActivationGate,
isBackgroundLaunch,
ownsAppRuntime,
registerNativeWindowActivation,
shouldBeginAppBootstrap,
shouldQuitOnWindowAllClosed
} from './window-lifecycle.js';

/** Durable state file holding the multi-agent run. Hashes only, never credentials. */



let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let shutdownStarted = false;
let shutdownComplete = false;
let stopSessionRetention: (() => void) | null = null;

// One instance only: two copies would fight over the tunnel and the config file.
app.setName('Chat On Steroids Local');
app.setPath('userData', path.join(app.getPath('appData'), 'Chat On Steroids Local'));
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // `app.quit()` does not make the rest of this module stop executing. Mark this process as a
  // terminal secondary instance immediately, so neither native activation nor the async bootstrap
  // below can touch shared config/durable state while the primary instance is still running.
  quitting = true;
  app.quit();
}

function createWindow(): void {
  const layout = windowLayoutForWorkArea(screen.getPrimaryDisplay().workArea);
  const icon = browserWindowIconPath(process.platform, app.isPackaged, process.resourcesPath);
  window = new BrowserWindow({
    ...layout,
    ...(icon ? { icon } : {}),
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: titleBarOverlayForTheme(getConfig().ui.theme)
    } : {}),
    // Painted before the renderer loads, so a dark window never flashes white.
    backgroundColor: getConfig().ui.theme === 'dark' ? '#0e0e11' : '#ffffff',
    title: 'Chat On Steroids Local',
    webPreferences: {
      zoomFactor: UI_BASE_ZOOM,
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // The renderer only ever loads our own local files.
      webSecurity: true
    }
  });

  if (process.platform === 'win32') window.removeMenu();

  window.once('ready-to-show', () => {
    // A renderer can finish loading after Cmd+Q has already entered bounded teardown. Never let
    // that late native event make the app visible again while `will-quit` is draining.
    if (!quitting) showWindow();
  });

  // A renderer that fails to load leaves a blank window with no other clue, so
  // record it where the diagnostics panel can show it.
  window.webContents.on('did-finish-load', () => logInfo('window loaded'));
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F11' || input.isAutoRepeat) return;
    event.preventDefault();
    window?.setFullScreen(!window.isFullScreen());
  });
  window.webContents.on('context-menu', (_event, params) => {
    const owner = window;
    if (!owner || owner.isDestroyed()) return;
    const template = editContextMenuTemplate(params);
    if (template.length) Menu.buildFromTemplate(template).popup({ window: owner });
  });
  window.webContents.on('did-fail-load', (_event, code, description) =>
    logError(`window failed to load (${code}): ${description}`)
  );
  // Renderer errors are otherwise invisible from here. Only errors, and only the
  // message text — never anything the page was working with.
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') logError(`renderer: ${details.message}`);
  });

  // Nothing in this app should ever open a second window or navigate away.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  window.on('close', (event) => {
    if (!quitting && getConfig().ui.minimizeToTray) {
      event.preventDefault();
      window?.hide();
    }
  });

  // Electron keeps the object after the window is gone, and every member on it throws from
  // then on. Holding that reference made `getWindow()` answer "yes, there is a window" for
  // the rest of the process, so the renderer pushes and the tray's Open both aimed at a
  // corpse. Dropping it is what makes those paths take their existing null branch.
  window.on('closed', () => {
    window = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function showWindow(): void {
  // Defense in depth for every current or future native activation source. The explicit gate
  // below additionally protects the long pre-window startup interval, while this invariant makes
  // a direct caller harmless once `before-quit` has started.
  if (quitting) return;
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  // Apply maximization before showing the window so startup has the native maximized
  // frame from its first visible paint. Preserve a user's explicit F11 fullscreen choice.
  if (!window.isFullScreen()) window.maximize();
  window.show();
  window.focus();
}

// Electron promises `second-instance` only after its own `ready`, not after our async startup.
// Until CSP/permission handlers and IPC are installed below, a re-launch is only a focus request
// for the initial window that startup is already going to show, so do not construct one early.
const windowActivation = createWindowActivationGate(showWindow);

/** Build the native tray image from encoded PNGs, never platform-dependent bitmap bytes. */
function trayIcon(running: boolean): Electron.NativeImage {
  const spec = trayImageSpec(process.platform, running);
  const [base, ...highDpi] = spec.representations;
  const image = nativeImage.createFromBuffer(base.png, { scaleFactor: base.scaleFactor });
  for (const representation of highDpi) {
    image.addRepresentation({
      scaleFactor: representation.scaleFactor,
      dataURL: `data:image/png;base64,${representation.png.toString('base64')}`
    });
  }
  if (spec.template) image.setTemplateImage(true);
  return image;
}

function refreshTray(): void {
  if (!tray) return;
  const state = getStatus().state;
  const connected = state === 'connected';
  const offline = state === 'offline';
  // Offline keeps the running icon: the bridge is up, the internet is not.
  const running = connected || offline;
  const label = connected ? 'Connected' : offline ? 'No internet' : 'Not connected';
  tray.setImage(trayIcon(running));
  tray.setToolTip(`Chat On Steroids — ${label.toLowerCase()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Open', click: windowActivation.request },
      {
        label: running ? 'Disconnect' : 'Connect',
        click: () => void (running ? disconnect() : connect())
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

app.on('second-instance', (_event, argv) => {
  if (!isBackgroundLaunch(argv)) windowActivation.request();
});

void app.whenReady().then(async () => {
  // This guard is intentionally before even app.getPath/init* calls. A secondary instance, or a
  // primary that was told to quit before ready, must never touch the primary's shared userData.
  if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;
  const userData = app.getPath('userData');
  initLogFile(path.join(userData, 'app.log'));
  initConfigPath(userData);
  initSecretsPath(userData);
  initSessionStore(userData);
  initDurableStore(userData);

  if (windowActivation.isDisabled()) return;
  await loadConfig();
  // Explicit first-run CLI import; credentials never enter argv or the renderer.
  if (process.env.COS_IMPORT_TUNNEL_KEY_FILE && process.env.COS_IMPORT_TUNNEL_ID) {
    const key = (await readFile(process.env.COS_IMPORT_TUNNEL_KEY_FILE, 'utf8')).trim();
    await setSecret('openaiApiKey', key);
    await updateConfig(async config => {
      const roots = [...config.roots];
      if (process.env.COS_IMPORT_ROOT) {
        const real = await validateNewRoot(process.env.COS_IMPORT_ROOT, roots);
        if (!roots.some(root => root.path === real)) roots.push({ name: uniqueRootName(real, roots), path: real });
      }
      return { ...config, roots, tunnel: { ...config.tunnel, tunnelId: process.env.COS_IMPORT_TUNNEL_ID! } };
    });
    delete process.env.COS_IMPORT_TUNNEL_KEY_FILE;
    delete process.env.COS_IMPORT_TUNNEL_ID;
    delete process.env.COS_IMPORT_ROOT;
  }
  await pluginManager.initialize(userData);
  if (windowActivation.isDisabled()) return;
  try { applyLoginStartup(app, getConfig().ui.startAtLogin === true); }
  catch (error) { logWarn(`Windows login startup: ${error instanceof Error ? error.message : String(error)}`); }
  // The renderer has its own explicit light/dark palette, so native chrome must follow the same
  // user choice instead of Electron's default `system` theme. On macOS this controls the window
  // frame, application menus and OS dialogs; on Linux/Windows it covers Electron-native UI.
  nativeTheme.themeSource = getConfig().ui.theme;
  // Strict CSP for our own page. There is no remote content and no inline script.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
        ]
      }
    });
  });

  // Deny every permission request; the UI needs none of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // From here on a second launch may safely focus/recreate the window: renderer security policy
  // is installed and the renderer's fixed IPC methods already have handlers before it can load.
  // The same quit the tray's Quit performs. It has to go through `quitting` for the window's
  // close-to-tray handler to let go: without it, quitting to install would hide the window and
  // leave the app running, which is exactly the trap the Install button exists to end.
  registerIpc(
    () => window,
    () => {
      quitting = true;
      app.quit();
    }
  );
  windowActivation.enable();
  if (!isBackgroundLaunch(process.argv)) windowActivation.request();
  // macOS `activate` can fire on first launch, so do not wire it at module load where it could
  // create a BrowserWindow before Electron is ready. Once the initial window path is established,
  // Dock activation/re-launch can safely recreate or focus it.
  registerNativeWindowActivation(app, windowActivation.request);

  tray = new Tray(trayIcon(false), ...trayGuidArgsForPlatform());
  tray.on('click', windowActivation.request);
  refreshTray();
  onStatusChange(refreshTray);

  logInfo('app started');

  if (getConfig().ui.autoConnect) void connect();

});

app.on('before-quit', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  quitting = true;
  // From this point `will-quit` owns a bounded teardown. A Dock click/relaunch arriving while
  // that sequence drains must not recreate or reveal a window after the tray has disappeared.
  windowActivation.disable();
});

app.on('window-all-closed', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  // macOS convention: closing the last window is not quitting the application. The Dock/menu
  // bar stay alive and `activate` recreates it. Windows/Linux retain the explicit close-to-tray
  // preference; Cmd+Q / app.quit bypasses this event and still enters the shutdown sequence.
  if (shouldQuitOnWindowAllClosed(process.platform, getConfig().ui.minimizeToTray)) app.quit();
});

app.on('will-quit', (event) => {
  // A secondary instance called app.quit() only to get out of the primary's way. It must be
  // allowed to exit normally: preventing that quit and flushing/stopping the primary's shared
  // stores from a process that never initialized or owns them is both a hang and data race.
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopSessionRetention?.();
  stopSessionRetention = null;
  tray?.destroy();
  tray = null;

  void runShutdownSequence(
    [
      // Phase 1: stop both listeners from admitting work and let accepted requests drain.
      // The budget has to clear the drains it contains, or it would silently defeat them:
      // the bridge force-closes wedged localhost sockets at 15s and the MCP endpoint forces
      // its own drain at 30s. This is the outer bound on both, not a competing one.
      { name: 'admission/drain', budgetMs: 40_000, run: () => [shutdownConnection()] },
      // Phase 2: only after request handlers are done may their owned child processes go.
      {
        name: 'process cleanup',
        budgetMs: 15_000,
        run: () => [unifiedExecManager.terminateAllProcesses(), stopComputerHelper(), pluginManager.close()]
      },
      { name: 'durable flush', budgetMs: 10_000, run: () => [flushDurable()] }
    ],
    {
      info: logInfo,
      warn: logWarn,
      error: logError,
      // Not `app.quit()`. See the note on ShutdownHooks.exit: a quit raised from the
      // continuation that ends this sequence is dropped by Electron, and the app is left
      // running with nothing to click and the single-instance lock still held.
      exit: () => {
        shutdownComplete = true;
        app.exit(0);
      }
    }
  );
});

// Belt and braces: no web contents anywhere in this app may open a window or
// navigate. External links go through the vetted allowlist in ipc.ts instead.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
});
