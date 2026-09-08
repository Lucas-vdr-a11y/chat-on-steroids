/**
 * The machinery every model-facing tool sits on, independent of which surface it lives on.
 *
 * The tools themselves are split by connector — `tools-core.ts` and `tools-desktop.ts` —
 * because a connector is a discovery boundary and that split is the whole point of the
 * design (see `docs/tool-surface.md` §6.4). None of what is in this file is surface-shaped:
 * error mapping, the call clock, the recording context, the agent key and the result
 * formatters behave identically wherever a tool is registered, and duplicating them per
 * surface is how two connectors would quietly start reporting the same thing differently.
 *
 * A tool first appears when its capability is enabled. For the lifetime of a running MCP
 * endpoint the exposed surface is monotonic: if that permission is later revoked, the tool
 * stays registered so a cached ChatGPT tool snapshot does not break, while the live handler
 * returns TOOL_DISABLED. Read-only mode is applied upstream in effectiveCapabilities, so a
 * fresh endpoint starts with every write tool absent.
 *
 * Annotations matter for real behaviour, not just documentation: ChatGPT treats a tool
 * without readOnlyHint as a write action and asks the user to confirm each call, so every
 * genuinely read-only tool is marked as such.
 */

import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { StoredText, ToolOutcome } from '../../shared/session.js';
import type { Capabilities, Root } from '../../shared/types.js';
import {
AgentError,
swarmRunning
} from '../agents.js';
import { ComputerError } from '../computer/index.js';
import { ExecError } from '../exec.js';
import { FsOpError, formatBytes, type FileInfo } from '../fsops.js';
import { logInfo, logWarn } from '../logger.js';
import { getSessionProject } from '../projects.js';
import { rawPromises as fs } from '../rawfs.js';
import {
SandboxError,
isAbsoluteVirtualPath,
isNativeWindowsPath,
resolvePath,
type Resolved
} from '../sandbox.js';
import {
evidenceWindow
} from '../session/recorder.js';
import { readOverflowText } from '../session/store.js';
import { currentWorkspace, learnWorkspace, setCurrentWorkspace } from '../workspace.js';
import {
currentCall,
emptyEvidence,
noteOutcome,
runInCallContext,
trackInFlight,
trackMcpRequest,
type CallContext
} from './call-context.js';
import { inboundRequestId } from './inbound.js';
import type { SurfaceId } from './surfaces.js';

export interface ToolContext {
  exposedFinishTool?: boolean;
  roots: Root[];
  /** Capabilities currently allowed by the live settings. */
  caps: Capabilities;
  /**
   * Capabilities whose tools must remain registered for the lifetime of the local MCP
   * endpoint. This prevents an already-cached ChatGPT tool snapshot from turning into
   * UNKNOWN when the user disables a permission mid-session. Calls are still checked
   * against `caps` and return TOOL_DISABLED instead of executing.
   */
  exposedCaps?: Capabilities;
  readOnly: boolean;
  /** When on, an unspecified screenshot captures only the foreground window. */
  privacyScreenshots?: boolean;
  /** Whether session recording is live right now. Defaults to the live setting. */
  sessionTools?: boolean;
  /** Whether multi-agent mode is live right now. Defaults to the live setting. */
  agentTools?: boolean;
  /**
   * Whether these feature tools must stay registered for the lifetime of the endpoint,
   * for the same reason as `exposedCaps`: ChatGPT caches a tools/list snapshot, and a
   * tool that disappears from under a cached snapshot surfaces as a transport-level
   * failure rather than a tidy error. Default to the live values.
   */
  exposedSessionTools?: boolean;
  exposedAgentTools?: boolean;
  /**
   * Whether `find` must stay registered for the lifetime of the endpoint.
   *
   * `find` and the exec pair are mutually exclusive, and that choice cannot be derived
   * from `exposedCaps.command` on each request: `exposedCaps` only ever widens, so a user
   * switching command execution on mid-run would silently *delete* `find` from under a
   * cached ChatGPT snapshot — the exact stale-snapshot failure the monotonic rule exists
   * to prevent. So the decision is made once, from the live capabilities, and then only
   * ever added to. Defaults to the live answer when the caller does not track it.
   */
  exposedFind?: boolean;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = { content: ToolContent[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Maps runtime errors to short model-facing text without ever exposing real paths. */
export function friendlyError(err: unknown): string {
  if (err instanceof SandboxError || err instanceof ComputerError) return err.message;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'Not found';
  if (code === 'EACCES' || code === 'EPERM') return 'Access denied by the operating system';
  if (code === 'EBUSY') return 'The file is in use by another program';
  if (code === 'ENOTEMPTY') return 'Directory is not empty';
  if (code === 'EEXIST') return 'Already exists';
  // Node filesystem errors routinely embed the absolute host path in `err.message`.
  // Unknown errno values (ELOOP, ENAMETOOLONG, EINVAL, ENOSPC, …) used to fall through
  // verbatim and violate the model-facing virtual-path contract. Keep the errno useful
  // without echoing the path Windows supplied.
  if (typeof code === 'string' && code.length > 0) return `Filesystem error (${code})`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Epoch ms of the last tool ChatGPT actually ran, or null if it never has.
 *
 * Deliberately separate from "a request arrived". ChatGPT connects, initialises and
 * lists tools on every connect even when the model is then forbidden to use them —
 * which is precisely what an account with Developer mode switched off looks like from
 * here. Only a tool that ran proves the whole chain, model included, works.
 *
 * Kept per surface as well as overall. "Has ChatGPT ever run a tool here" is the only
 * honest proof a connector was created and works, and with two connectors the answer for
 * one says nothing about the other — a user whose Core connector is fine and whose
 * Desktop connector was never added would otherwise see setup reported as finished.
 */
let toolCallSeenAt: number | null = null;
const surfaceToolCallAt = new Map<SurfaceId, number>();

export function lastToolCallAt(surface?: SurfaceId): number | null {
  if (surface === undefined) return toolCallSeenAt;
  return surfaceToolCallAt.get(surface) ?? null;
}

/** Cleared with the server, so the answer is always about the current session. */
export function resetToolClock(): void {
  toolCallSeenAt = null;
  surfaceToolCallAt.clear();
  transportIdentity = { checked: false, present: false };
}

/**
 * Turns any thrown error into a tool execution error the model can act on, and keeps
 * unexpected internals out of the response. Error results are logged with only their
 * first line, so Activity stays useful without copying command output or file contents.
 */
export async function guard(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const started = Date.now();
  // Counted before the work, and counted even when the tool is disabled or fails:
  // the question this answers is whether the model may call us at all.
  toolCallSeenAt = started;
  try {
    const result = await fn();
    const elapsed = Date.now() - started;
    if (result.isError) {
      const summary = result.content
        .find((item): item is Extract<ToolContent, { type: 'text' }> => item.type === 'text')
        ?.text.split(/\r?\n/, 1)[0]
        ?.slice(0, 500);
      // A rejected edit, disabled permission, stale cursor, etc. is a normal tool
      // outcome, not evidence that the connector itself is unhealthy.
      noteOutcomeSafely('tool_rejected');
      logInfo(`tool ${name} rejected in ${elapsed} ms${summary ? `: ${summary}` : ''}`);
    } else {
      noteOutcomeSafely('ok');
      logInfo(`tool ${name} ok in ${elapsed} ms`);
    }
    return result;
  } catch (err) {
    const message = friendlyError(err);
    const elapsed = Date.now() - started;
    if (
      err instanceof SandboxError ||
      err instanceof ComputerError ||
      err instanceof FsOpError ||
      err instanceof ExecError ||
      err instanceof AgentError
    ) {
      noteOutcomeSafely('tool_rejected');
      logInfo(`tool ${name} rejected in ${elapsed} ms: ${message}`);
    } else {
      noteOutcomeSafely('tool_internal_error');
      logWarn(`tool ${name} failed in ${elapsed} ms: ${message}`);
    }
    return fail(message);
  }
}

// noteOutcome is only meaningful inside a call context; guard is also used by tests and
// by internal paths that have none, and a missing context must not turn into an error.
function noteOutcomeSafely(outcome: ToolOutcome): void {
  try {
    noteOutcome(outcome);
  } catch {
    /* no call context: nothing to record against */
  }
}

/** The only SDK handler context field this layer consumes; request identity comes from ingress ALS. */
type McpCallContext = Pick<ServerContext, 'sessionId'>;

/**
 * ChatGPT's id for this request, from `x-request-id`, without the per-attempt suffix.
 *
 * The header arrives as `wfr_<id>/<suffix>` and ChatGPT's own message model holds the
 * `wfr_<id>` half, so the suffix is dropped rather than matched on. Measured live on
 * 2026-08-18: header `wfr_01a014bdd7cd7a15b6b533d3ce2b42f2/yqy1`, page evidence
 * `read#wfr_01a014bdd7cd7a15b6b533d3ce2b42f2`.
 *
 * This is what makes caller identity a lookup instead of an inference. Before it, two
 * workers of the same run calling `agents` seconds apart were indistinguishable — both
 * conversations had named an unclaimed `agents` request inside the same window — and both
 * were refused WORKER_IDENTITY_LOST. Nothing about timing needs to be assumed now.
 */
function requestIdOf(mcpCtx: McpCallContext | undefined): string | null {
  // server.ts normalizes x-request-id exactly once at raw HTTP ingress and binds that value
  // to this async request. Re-reading the SDK header here would create a second parser/source
  // of truth for the correlation key.
  void mcpCtx;
  return inboundRequestId();
}

/**
 * Whether the MCP transport ever gave us a session id, once a real call has arrived.
 *
 * Recorded rather than assumed, because it is the one thing that would let this app know
 * which conversation is calling without asking the browser at all. Until it does, identity
 * comes from page evidence. This is what the Activity log reports on the first tool call of
 * each run.
 */
let transportIdentity: { checked: boolean; present: boolean } = { checked: false, present: false };

export function transportIdentityStatus(): { checked: boolean; present: boolean } {
  return { ...transportIdentity };
}

/**
 * Runs one tool call inside a recording context.
 *
 * Registration is wrapped rather than each handler, so the arguments and the result
 * recorded are exactly the ones that crossed the wire — the recorder never has to
 * reconstruct a call from a log line — and so identity is resolved in one place.
 *
 * `finishing` replaces the old `name === 'finish_agent'` test: with the collapsed
 * `agents` tool the terminal call is an *action* rather than a tool name, and the
 * re-offer rule has to follow the action.
 */
export async function dispatch(
  name: string,
  _args: unknown,
  transportKey: string | null,
  _requestId: string | null,
  surface: SurfaceId,
  run: () => Promise<ToolResult>
): Promise<ToolResult> {
  // The context is built here, one layer out from where the work happens, because the
  // compaction barrier asks about the whole request and not just the handler. A call is
  // still unsettled while it waits for its request-id evidence, while its outcome is being
  // recorded, and while its result is on the way back — and a handoff written in any of
  // those gaps describes a machine that has not finished changing. The counter therefore
  // opens with the request and closes with it.
  const context: CallContext = {
    startedAt: Date.now(),
    transportKey,
    agent: null,
    caller: { transportKey, requestId: null, conversationId: null, sessionId: null },
    outcome: null,
    evidence: emptyEvidence()
  };
  return trackMcpRequest(() =>
    trackInFlight(context, () => {
      surfaceToolCallAt.set(surface, Date.now());
      return runInCallContext(context, () => guard(name, run));
    })
  );
}

/**
 * Refused to a chat whose session is being compacted into a fresh chat.
 *
 * The brief is the whole point of that window and the one thing the model is asked for, so
 * the refusal is written to steer a turn that is still busy with its old task straight into
 * writing it — and to make a chat with an unstoppable turn harmless, since nothing it calls
 * now can change the machine the brief describes.
 */
export const COMPACTION_IN_PROGRESS_REFUSAL =
  'COMPACTION_IN_PROGRESS: this chat is being compacted into a fresh chat, and no local tool was run. ' +
  'Nothing will run here until the handoff is done. Make no further tool calls of any kind. The latest ' +
  'user message asks for the handoff brief: write that brief now, as plain text, and then stop. ' +
  'Work continues in the replacement chat.';

export async function adoptAgent(agent: string | null): Promise<void> {
  const context = currentCall();
  if (!context || !agent) return;
  context.agent = agent;
  // Identity adoption is intentionally pure. A handler may prove identity more strongly than
  // ingress could, but it must not also retire inbox state: the dispatcher owns exactly one ACK
  // point after the handler, where it knows whether this call is a finish retry and can apply
  // the finish-specific at-least-once rule correctly.
}

/**
 * A path named by a tool call, resolved against the chat's workspace when it is relative.
 *
 * Every path argument in every tool goes through here rather than calling `resolvePath`
 * directly, for two reasons. Shorthand then means the same thing in `read` as in `exec` as in
 * `apply_patch` — a model that learns it once has learned it everywhere — and the workspace is
 * learned from every absolute path a call has *proved* it can reach, so no tool has to
 * remember to teach it.
 *
 * The sandbox underneath is untouched. `resolvePath` still performs every root, containment,
 * `..` and symlink check it ever did; the workspace only supplies a prefix for a path that
 * arrived without one, before any of that runs. A chat with no workspace gets the same
 * refusal it would have got for a relative path before, which is why ambiguity here costs a
 * retry rather than reaching the wrong file.
 */
async function validatedWorkspace() {
  const sessionId = currentCall()?.caller.sessionId;
  // Explicit project bindings are durable authority, even after a cwd was learned.
  // Validate first so a revoked or moved project never becomes a first-root fallback.
  const project = sessionId ? await getSessionProject(sessionId) : null;
  const workspace = currentWorkspace();
  if (!workspace && project) setCurrentWorkspace(project);
  return workspace ?? currentWorkspace();
}

export async function resolveIn(
  roots: Parameters<typeof resolvePath>[0],
  requested: string,
  options: { allowMissing?: boolean; base?: string | null } = {}
): Promise<Resolved> {
  // An explicit adapter-supplied base beats the workspace; otherwise the workspace is the base.
  // Either way the joining happens inside `resolvePath`, ahead of validation,
  // so a `..` in the caller's text still meets `checkSegment` instead of being normalised
  // away first. Doing that join here is how a relative patch path could climb out of the
  // workspace: `posix.normalize('/root/a/../../elsewhere')` is a perfectly clean-looking
  // `/elsewhere`, and nothing downstream can tell it apart from a path that was always that.
  const workspace = await validatedWorkspace();
  const base = options.base !== undefined ? options.base : (workspace?.virtual ?? null);
  const resolved = await resolvePath(roots, requested, {
    ...(options.allowMissing === undefined ? {} : { allowMissing: options.allowMissing }),
    base
  });
  // Absolute only: a workspace learned from a relative path would let one loose resolution
  // decide where the next loose resolution points. See workspace.ts.
  if (isAbsoluteVirtualPath(requested) || isNativeWindowsPath(requested)) await learnWorkspace(resolved);
  return resolved;
}

export interface ResolvedCwd {
  real: string;
  virtual: string;
  /** True when the caller named no folder, so the workspace or first root was used instead. */
  defaulted: boolean;
}

/**
 * The working directory a command tool may use, restricted to an approved root.
 *
 * The caller is told which folder this turned out to be, and whether it was a default,
 * because omitting `workdir` while working inside a nested project is a quiet way to run the
 * wrong build: a live run meant for `…/minecraft-web-demo` fell back to the first root and
 * rebuilt the parent Electron app instead, and nothing in the reply said so.
 */
export async function resolveCwd(ctx: ToolContext, virtualPath: string | undefined): Promise<ResolvedCwd> {
  // The chat's own folder before the first root: a command with no `workdir` should run where the
  // chat has been working, which is the whole point of the workspace and is exactly the case
  // the note above describes going wrong.
  const workspace = await validatedWorkspace();
  // Codex treats an explicitly empty workdir exactly like an omitted one.
  const provided = virtualPath !== undefined && virtualPath !== '';
  if (!provided && !workspace && swarmRunning()) {
    throw new SandboxError(
      'WORKSPACE_REQUIRED: this multi-agent chat has no proven workspace. Supply an explicit approved workdir before running a command.'
    );
  }
  const target = provided ? virtualPath : (workspace?.virtual ?? (ctx.roots[0] ? `/${ctx.roots[0].name}` : ''));
  if (!target) throw new SandboxError('No folder is approved, so there is nowhere to run');
  const resolved = await resolveIn(ctx.roots, target);
  const stat = await fs.stat(resolved.real);
  if (!stat.isDirectory()) throw new SandboxError('workdir must be a folder');
  return { real: resolved.real, virtual: resolved.virtual, defaulted: !provided };
}

// ------------------------------------------------------------------ shared args

export const pathArg = z.string().min(1).max(4096);
export const lineNumberArg = z.number().int().min(1).max(100_000_000);
export const windowIdArg = z.number().int().min(1).max(4_294_967_295);
export const imageCoordinateArg = z.number().int().min(-100_000).max(100_000);
// Zod's plain object parser strips unknown keys even though its generated JSON Schema says
// additionalProperties=false. Keep runtime validation as strict as the wire contract so a
// misspelled coordinate/crop field cannot be silently discarded.
export const pointArg = z.object({ x: imageCoordinateArg, y: imageCoordinateArg }).strict();
export const cropArg = z
  .object({
    x: z.number().int().min(0).max(100_000),
    y: z.number().int().min(0).max(100_000),
    width: z.number().int().min(1).max(100_000),
    height: z.number().int().min(1).max(100_000)
  })
  .strict();
export const mouseButtonArg = z.enum(['left', 'right', 'middle']);
// ------------------------------------------------------------------ registration

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * What a surface module is handed to register its tools with.
 *
 * Passing a small object rather than the raw `McpServer` is what keeps the two surface
 * modules from being able to diverge on the things that must not differ: every tool goes
 * through `dispatch`, every tool gets the agent key under the same condition, and every
 * capability refusal reads the same. A surface decides *which* tools exist, never how a
 * tool is wired up.
 */
export interface SurfaceRegistrar {
  ctx: ToolContext;
  caps: Capabilities;
  exposedCaps: Capabilities;
  sessionToolsLive: boolean;
  sessionToolsExposed: boolean;
  agentToolsLive: boolean;
  agentToolsExposed: boolean;
  /** Whether `find` is part of this endpoint's surface. See ToolContext.exposedFind. */
  findExposed: boolean;
  register<Schema extends z.ZodType>(
    name: string,
    config: {
      title?: string;
      description: string;
      inputSchema: Schema;
      outputSchema?: z.ZodType;
      annotations?: ToolAnnotations;
      /**
       * Opaque host metadata advertised verbatim in tools/list.
       * Used once by download_artifact for {"openai/fileParams": ["file"]},
       * which tells ChatGPT to inject the native file value. Never interpreted here.
       */
      _meta?: Record<string, unknown>;
    },
    handler: (args: z.output<Schema>) => Promise<ToolResult>
  ): void;
  /** Runs `fn` only while `cap` is live, and explains the refusal otherwise. */
  guarded(cap: keyof Capabilities, name: string, fn: () => Promise<ToolResult>): Promise<ToolResult>;
  /** Refusal used when a whole feature is off but its tool is still exposed. */
  featureDisabled(feature: string, setting: string): ToolResult;
  /** Names actually registered on this server, in registration order. */
  registered(): string[];
}

export function createRegistrar(server: McpServer, ctx: ToolContext, surface: SurfaceId, observe?: (name: string, config: { description: string; inputSchema: z.ZodType; annotations?: ToolAnnotations }) => void): SurfaceRegistrar {
  const caps = ctx.caps;
  const exposedCaps = ctx.exposedCaps ?? caps;
  // These two do not follow a capability checkbox: they are whole features the user
  // switches on in the app, and neither touches the filesystem. Like the capability
  // tools they are exposed monotonically and disabled at the handler, so switching a
  // feature off does not delete a tool a cached ChatGPT snapshot still believes in.
  const sessionToolsLive = false;
  const agentToolsLive = false;
  const sessionToolsExposed = false;
  const agentToolsExposed = false;
  const findExposed = ctx.exposedFind ?? (!exposedCaps.command && exposedCaps.search);
  const names: string[] = [];

  return {
    ctx,
    caps,
    exposedCaps,
    sessionToolsLive,
    sessionToolsExposed,
    agentToolsLive,
    agentToolsExposed,
    findExposed,
    registered: () => [...names],
    register(name, config, handler) {
      if (['session', 'agents', 'session_finish'].includes(name)) return;
      names.push(name);
      observe?.(name, config);
      // No identity field is ever added here. Every tool's schema is exactly what its
      // surface declared: who is calling is a fact about the conversation, established from
      // page evidence in `dispatch`, and never something the model is asked to carry.
      server.registerTool(name, config, ((args: never, mcpCtx?: McpCallContext) =>
        dispatch(name, args, mcpCtx?.sessionId ?? null, requestIdOf(mcpCtx), surface, () =>
          handler(args)
        )) as never);
    },
    guarded(cap, name, fn) {
      return guard(name, async () => {
        if (!caps[cap]) {
          return fail(
            `TOOL_DISABLED: ${name} is disabled by the current Chat On Steroids permissions. ` +
              'Ask the user to enable the permission in the app, then retry. If the tool list in this conversation is stale, start a new chat.'
          );
        }
        return fn();
      });
    },
    featureDisabled(feature, setting) {
      return fail(
        `FEATURE_DISABLED: ${feature} is switched off in Chat On Steroids. ` +
          `Ask the user to enable "${setting}" in the app, then try again.`
      );
    }
  };
}

// ------------------------------------------------------------------ formatters

/**
 * Largest brief a handoff save will accept.
 *
 * Generous on purpose. A brief that hits this is a symptom — the compaction of a very
 * long session — and refusing it there would throw away the one artefact the whole flow
 * exists to produce. The bound is only to keep a runaway generation from being written
 * to disk unbounded; at roughly four characters per token this is comfortably past any
 * single ChatGPT answer.
 */
export const MAX_HANDOFF_CHARS = 400_000;

/**
 * How long a prime-role `agents` call waits for the calling chat to show its own block.
 *
 * The prime holds no credential, so this window *is* its identity, and it has to be
 * evidence from this call: a block rendered after the call began, in exactly one
 * conversation. Shorter than a join because a prime calls `agents` repeatedly during a run
 * and a join happens once, but long enough that a page reporting on its own tick lands
 * inside it. Nothing falls back to "the only chat that has been active lately".
 */
export const PRIME_EVIDENCE_MS = evidenceWindow(2_500);

/**
 * The same window for a call ChatGPT gave a request id, which is waiting for one exact
 * page record rather than for whichever block turns up.
 *
 * Two and a half seconds was measured too short for the case that matters most: a worker's
 * first `agents` call runs seconds after its tab opened, and on 2026-08-18 worker-1 was
 * told WORKER_IDENTITY_LOST at 16:33:56 with the page evidence for that very call arriving
 * at 16:34:04. The wait is event-driven and ends the instant the mate lands, so the extra
 * seconds are only ever spent by a call that was going to be refused anyway.
 */
export const IDENTITY_EVIDENCE_MS = evidenceWindow(15_000);

/**
 * The same window again for the two `agents` actions whose refusal cannot be retried cheaply.
 *
 * Everything else that waits for identity is asking about work it can decline and be asked
 * for again a moment later. `spawn` is not: a refused `spawn` ends the turn with
 * no run, and the model's own retry costs the user another full generation — on 2026-08-21 it
 * cost two, and the run still never started. The wait is event-driven and returns the instant
 * the page's request-id mate lands, so a longer ceiling is only ever spent by a call that was
 * going to be refused anyway; against that, the live evidence shows ids arriving twenty
 * seconds after the window that refused them. Kept well inside ChatGPT's own connector
 * timeout, so a slow proof still comes back as a spawned run rather than as a dead call.
 */
export const SPAWN_EVIDENCE_MS = evidenceWindow(30_000);

/**
 * Recovers the complete text behind a stored field.
 *
 * A long tool argument or result is bounded inline in the log and written whole beside
 * it; this reads the whole one back so recovery means the exact payload rather than
 * its first eight thousand characters. `complete` is false only when even the overflow
 * copy could not be written, and the caller says so instead of implying otherwise.
 */
export async function expandStored(
  sessionId: string,
  stored: StoredText
): Promise<{ text: string; complete: boolean }> {
  if (!stored.truncated) return { text: stored.text, complete: true };
  if (stored.assetId) {
    const full = await readOverflowText(sessionId, stored.assetId);
    if (full !== null) return { text: full, complete: true };
  }
  return { text: stored.text, complete: false };
}

/** Splits on blank lines so a part never ends mid-sentence unless a block is huge. */
export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let current = '';
  for (const block of text.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= size) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (block.length <= size) {
      current = block;
    } else {
      for (let at = 0; at < block.length; at += size) parts.push(block.slice(at, at + size));
      current = '';
    }
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [''];
}

/** The per-path header `read` prints. This is what `file_info` used to be. */
export function formatFileInfo(info: FileInfo): string {
  const lines = [
    `path: ${info.virtualPath}`,
    `type: ${info.type}`,
    `size: ${formatBytes(info.bytes)}`,
    `modified: ${info.modified}`,
    `created: ${info.created}`
  ];
  if (info.readOnly) lines.push('readonly: true');
  if (info.binary !== null) lines.push(`binary: ${info.binary}`);
  if (info.lines !== null) lines.push(`lines: ${info.lines}`);
  if (info.sha256) lines.push(`sha256: ${info.sha256}`);
  return lines.join('\n');
}
