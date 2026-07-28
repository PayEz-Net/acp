import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import {
  type AcpAgentCapabilities,
  type AcpAgentInfo,
  type AcpContentBlock,
  type AcpEventPayload,
  type AcpPermissionOption,
  type AcpPromptImage,
  type AcpSendContentBlock,
  type AcpSessionUpdate,
  type AcpToolCall,
  type AcpWaitState,
} from '../../shared/acpTypes';
import { IPC_CHANNELS, type AgentSessionStartFailedPayload, type TerminalProvider } from '../../shared/types';
import { AcpProcess, type AcpJsonRpcMessage } from './AcpProcess';
import { sanitizeAcpDisplayText } from '../../shared/acpSanitize';
import {
  getProviderConfig,
  kimiK3ThinkingEffortEnv,
  kimiSpawnArgs,
  ModelNotRecognizedError,
  type ProviderConfig,
} from './providerConfigs';
import { buildAgentBootPrompt, buildAgentResumeNudge } from './bootPrompt';
import { acpApiGetAgentProfile, acpApiGetUnreadMailCount } from '../acp-api-client';
import { startAgentSession, endAgentSession } from '../agentSessionLifecycle';
import { getSettings, setSettings } from '../store';

export interface AcpRuntimeOptions {
  agentName: string;
  workDir: string;
  projectId?: number;
  bootPrompt?: string;
  effort?: string;
  /** Bare kimi model id (`k3` | `kimi-for-coding` | `kimi-for-coding-highspeed`)
   *  from team_agent_instances.model_override (the engaged standing team's
   *  per-placement override — live-team model). null/absent = inherit
   *  default_model. Unknown ids throw ModelNotRecognizedError at spawn —
   *  never a silent fallback to the default model. */
  modelOverride?: string | null;
  /** Numeric agent id from the project team table. Used to start a PayEzVibe
   *  agent session while this runtime is alive. */
  agentId?: number;
}

interface PendingPermission {
  requestId: number | string;
  resolve: (optionId: string) => void;
}

// Global serialization lock for ACP provider initialization. Kimi's CLI has
// shared global state (~/.kimi config, lock files, etc.) that races when N
// processes initialize in parallel, producing -32603 internal errors. Running
// initialize/session.new one-at-a-time eliminates that contention.
let initLock = Promise.resolve();

/**
 * Deterministic startup failure: the spawned kimi/acp-adapter is older than
 * the floor the desktop's image pipeline depends on (server-side image format
 * gate + compression, kimi ≥ 0.23.5). Retrying can never fix a version, so
 * start() rethrows immediately like ModelNotRecognizedError.
 */
export class UnsupportedAgentVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedAgentVersionError';
  }
}

/**
 * Minimum kimi/acp-adapter version for the delegated image pipeline
 * (WO-ACP-KIMI-NATIVE-IMAGE-PASTE §4). Below this the server-side image gate
 * does not exist, so the desktop refuses to run the runtime at all.
 */
const MIN_AGENT_VERSION: readonly [number, number, number] = [0, 23, 5];

/**
 * Parse a leading semver triple (`x.y.z`, optional `v` prefix). Returns null
 * for absent/unparseable versions — callers warn and proceed rather than
 * blocking startup on a runtime that doesn't report a clean version.
 */
function parseSemver(version: string | undefined): [number, number, number] | null {
  if (!version) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionBelow(version: [number, number, number], floor: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== floor[i]) return version[i] < floor[i];
  }
  return false;
}

/**
 * Read the active model's image-input capability out of a session/new (or
 * resume) result's `configOptions` (kimi-code fork delta: the `model` select
 * arm carries per-option `imageIn`). Returns undefined when the runtime does
 * not advertise it — older runtimes leave the UX gate open and let the server
 * gate be the backstop.
 */
function extractActiveModelImageIn(sessionResult: Record<string, unknown>): boolean | undefined {
  const arms = sessionResult.configOptions;
  if (!Array.isArray(arms)) return undefined;
  const modelArm = arms.find(
    (arm): arm is Record<string, unknown> =>
      !!arm && typeof arm === 'object' && (arm as Record<string, unknown>).id === 'model',
  );
  if (!modelArm) return undefined;
  const currentValue = modelArm.currentValue;
  const options = modelArm.options;
  if (typeof currentValue !== 'string' || !Array.isArray(options)) return undefined;
  const active = options.find(
    (opt): opt is Record<string, unknown> =>
      !!opt && typeof opt === 'object' && (opt as Record<string, unknown>).value === currentValue,
  );
  if (!active) return undefined;
  return typeof active.imageIn === 'boolean' ? active.imageIn : undefined;
}

async function acquireInitLock(): Promise<() => void> {
  const oldLock = initLock;
  let release: () => void;
  initLock = new Promise<void>((resolve) => { release = resolve; });
  await oldLock;
  return release!;
}

export class AcpRuntimeManager extends EventEmitter {
  private process: AcpProcess | null = null;
  private sessionId: string | null = null;
  // Preserve the session id across runtime restarts so a watchdog/crash
  // restart can resume the prior session via session/resume instead of
  // re-onboarding into an empty session/new (which wiped the agent's entire
  // working context). Cleared only when a fresh session is established.
  private lastSessionId: string | null = null;
  // Whether the most recent startOnce() resumed an existing session. restart()
  // uses this to decide whether queued prompts drain (context kept) or drop
  // with a visible error (fresh session, context gone).
  private resumedLastStart = false;
  // Whether this runtime has completed a startOnce() in this process.
  // Distinguishes an app-launch resume (renderer booted blank — the agent
  // needs a wake-up nudge to visibly come online) from an in-process watchdog
  // restart (renderer still holds the transcript — stay silent).
  private hasStartedThisProcess = false;
  private initialized = false;
  private pendingPermissions = new Map<number | string, PendingPermission>();
  private autoApprove = false;
  private capabilities: AcpAgentCapabilities | undefined = undefined;
  /**
   * Active model's image-input capability from the session's configOptions
   * (kimi-code fork delta on the `model` select arm). undefined = runtime did
   * not advertise it (older version or resumed session without configOptions);
   * the composer treats that as "allow, server gate decides".
   */
  private imageIn: boolean | undefined = undefined;

  // Inactivity watchdog while a session/prompt is pending. A fixed timeout
  // falsely kills slow-but-healthy turns (tool calls, long reasoning). We
  // only declare a hang when the runtime has been completely silent for a
  // while, and we auto-restart when that happens.
  private promptPending = false;
  private promptIdleTicks = 0;
  private inactivityTimer: ReturnType<typeof setInterval> | null = null;
  private promptSettledRef: { current: boolean } | null = null;

  // Kimi's ACP runtime does not handle concurrent session/prompt requests on
  // the same session; overlapping calls produce -32603 internal errors and can
  // cause the in-flight turn to return an empty end_turn. Queue prompts so only
  // one is ever in flight at a time.
  private promptQueue: Array<{ prompt: AcpSendContentBlock[]; resolve: (dispatched: boolean) => void }> = [];
  // Prompts sent THROUGH into the active turn (slice B steer passthrough).
  // Tracked (with their prompt) so kill()/dropQueuedPrompts can settle their
  // waiters exactly like queued prompts — and so a resumed restart can
  // re-dispatch them (the turn they rode died with the old process).
  private pendingSteers = new Set<{ prompt: AcpSendContentBlock[]; resolve: (dispatched: boolean) => void }>();
  private promptInFlight = false;

  // Crash-recovery state. We track whether a kill was intentional so an
  // unexpected process exit can auto-restart, and we back off so a repeatedly
  // crashing runtime (e.g., Kimi cold-init race on Windows) doesn't spin forever.
  private intentionalKill = false;
  private restarting = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly MAX_RESTARTS = 5;

  // Pending re-dispatch after a turn.agent_busy re-sync (see the catch branch
  // in executePrompt). One at a time. The episode is bounded twice: a cap of
  // MAX_AGENT_BUSY_REJECTIONS consecutive rejections escalates to a
  // fresh-session restart, and the prompt idle watchdog remains the backstop
  // if the busy turn never ends.
  private agentBusyRetryTimer: ReturnType<typeof setTimeout> | null = null;
  // Consecutive turn.agent_busy rejections in the current episode. Reset on
  // any successful dispatch and on episode end (non-busy rejection, process
  // loss, empty retry queue, kill, escalation).
  private agentBusyRejectionCount = 0;
  // Whether the early best-effort session/cancel (AGENT_BUSY_CANCEL_AFTER)
  // already fired in the current episode — the escalation at the cap skips
  // its own cancel when it did. Reset alongside the rejection count.
  private agentBusyCancelSent = false;
  // One-shot skip honored and cleared by startOnce(): after a busy episode
  // that outlived its retry cap (or the whole idle budget), the next start
  // falls back to session/new instead of resuming — a busy condition that
  // survives the episode is a property of the resumed session, and
  // re-resuming it just re-enters the busy loop.
  private skipResumeOnce = false;

  // Preserve the most recent user prompts across runtime restarts so a watchdog
  // restart (or unexpected process crash) doesn't force the user to restate the
  // mission from scratch. We keep a short sliding window in the main process
  // because the renderer-side transcript store is not reachable here.
  private recentUserPrompts: string[] = [];
  private readonly MAX_PRESERVED_PROMPTS = 6;

  constructor(
    private readonly id: string,
    private readonly provider: ProviderConfig,
    private readonly options: AcpRuntimeOptions,
  ) {
    super();
    // Hydrate the session id from the previous app run so session/resume can
    // reattach the agent's working context after an app crash/restart, not
    // just after in-process runtime restarts. Absent/unknown ids are a no-op:
    // startOnce() falls back to session/new when resume fails.
    this.lastSessionId = this.readPersistedSessionId();
  }

  /** electron-store key scoping this runtime's persisted session id. */
  private get sessionPersistKey(): string {
    return `${this.options.agentName}::${this.options.workDir}`;
  }

  private readPersistedSessionId(): string | null {
    try {
      return getSettings().acpSessionIds?.[this.sessionPersistKey] ?? null;
    } catch (err) {
      // Settings read failure must never block runtime startup.
      console.warn(`[ACP ${this.options.agentName}] failed to read persisted session id:`, err);
      return null;
    }
  }

  private persistSessionId(sessionId: string): void {
    try {
      const current = getSettings().acpSessionIds ?? {};
      if (current[this.sessionPersistKey] === sessionId) return;
      setSettings({ acpSessionIds: { ...current, [this.sessionPersistKey]: sessionId } });
    } catch (err) {
      // Persistence is best-effort; losing it only means the next app
      // restart starts a fresh session instead of resuming.
      console.warn(`[ACP ${this.options.agentName}] failed to persist session id:`, err);
    }
  }

  getId(): string {
    return this.id;
  }

  getAgentName(): string {
    return this.options.agentName;
  }

  getProjectId(): number | undefined {
    return this.options.projectId;
  }

  getProvider(): TerminalProvider {
    return this.provider.id;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled;
  }

  private startPromptWatchdog(): void {
    const WATCHDOG_INTERVAL_MS = 15_000;
    // 120s was too aggressive for legitimately silent-but-working turns (deep
    // reasoning, long tool calls without progress pings). 5 minutes gives those
    // turns room to breathe. This is the sole hang detector: there is no
    // wall-clock ceiling on session/prompt, and only content-bearing
    // notifications reset the idle clock (see handleNotification).
    const PROMPT_IDLE_MS = 300_000;
    const WATCHDOG_IDLE_TICKS = Math.ceil(PROMPT_IDLE_MS / WATCHDOG_INTERVAL_MS);
    this.promptPending = true;
    this.promptIdleTicks = 0;
    if (this.inactivityTimer) clearInterval(this.inactivityTimer);
    this.inactivityTimer = setInterval(() => {
      if (!this.promptPending) {
        this.stopPromptWatchdog();
        return;
      }
      // If the OS process is already gone, there will never be another
      // notification. Fail the turn immediately and restart rather than waiting
      // for the full idle timeout.
      if (!this.process?.isRunning()) {
        const message = `ACP process for ${this.options.agentName} died while a turn was pending; restarting runtime`;
        console.warn(`[ACP ${this.options.agentName}] ${message}`);
        // Settle the pending prompt promise so its .catch doesn't fire a
        // duplicate error / restart scheduling below.
        if (this.promptSettledRef) this.promptSettledRef.current = true;
        this.failPendingTurn(message);
        void this.restart();
        return;
      }
      this.promptIdleTicks++;
      if (this.promptIdleTicks >= WATCHDOG_IDLE_TICKS) {
        if (this.promptSettledRef?.current) {
          this.stopPromptWatchdog();
          return;
        }
        this.promptSettledRef!.current = true;
        const message = `No response from ${this.options.agentName} for ${Math.round((this.promptIdleTicks * WATCHDOG_INTERVAL_MS) / 1000)}s while a turn was pending; restarting runtime`;
        console.warn(`[ACP ${this.options.agentName}] ${message}`);
        // Best-effort cancel: a merely-slow runtime may still honor it and
        // resolve the turn; a truly hung one ignores it and gets killed by the
        // restart. Either way the turn is declared over here so the queue is
        // not held hostage by a promise that may never settle.
        //
        // A busy re-sync episode that consumed the whole idle budget will not
        // be fixed by re-resuming the same session: the next start falls back
        // to session/new exactly once (same one-shot skip as the busy-cap
        // escalation in executePrompt).
        if (this.agentBusyRejectionCount > 0) {
          this.agentBusyRejectionCount = 0;
          this.agentBusyCancelSent = false;
          this.skipResumeOnce = true;
        }
        this.process?.notify('session/cancel', { sessionId: this.sessionId });
        this.failPendingTurn(message);
        void this.restart();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  /**
   * Declare the in-flight turn over without touching the process or the
   * session: surface the error, emit a turn_complete so the renderer clears
   * its spinner, and release the in-flight flag so the prompt queue can move.
   * Callers decide whether the runtime itself also needs a restart.
   */
  private failPendingTurn(message: string): void {
    this.stopPromptWatchdog();
    this.emitAcpEvent({
      sessionUpdate: 'error',
      sessionId: this.sessionId ?? '',
      error: message,
    });
    this.emitAcpEvent({
      sessionUpdate: 'turn_complete',
      sessionId: this.sessionId ?? '',
      stopReason: 'cancelled',
    });
    this.promptInFlight = false;
  }

  private stopPromptWatchdog(): void {
    this.promptPending = false;
    if (this.inactivityTimer) {
      clearInterval(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    this.promptSettledRef = null;
  }

  private markPromptActivity(): void {
    if (this.promptPending) {
      this.promptIdleTicks = 0;
    }
  }

  async start(): Promise<void> {
    if (this.process) return;

    const maxAttempts = 3;
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.startOnce();
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        // Deterministic errors (unknown model id, kimi below the version floor)
        // can never succeed on retry — fail loud immediately instead of burning
        // the backoff loop.
        if (lastErr instanceof ModelNotRecognizedError) throw lastErr;
        if (lastErr instanceof UnsupportedAgentVersionError) throw lastErr;
        console.warn(`[ACP] start attempt ${attempt}/${maxAttempts} failed for ${this.options.agentName}: ${lastErr.message}`);
        this.cleanupProcess();
        if (attempt < maxAttempts) {
          const delay = attempt * 2000;
          console.log(`[ACP] retrying ${this.options.agentName} in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    const finalErr = lastErr ?? new Error(`ACP runtime failed to start for ${this.options.agentName}`);
    this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? undefined, error: finalErr.message });
    throw finalErr;
  }

  private cleanupProcess(): void {
    this.stopPromptWatchdog();
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.process = null;
    }
    this.sessionId = null;
    this.initialized = false;
    void endAgentSession(this.id, 'normal');
  }

  private async startOnce(): Promise<void> {
    const [command, ...baseArgs] = this.provider.acpCommand;
    // Per-agent kimi model selection (WO-KIMI-MODEL-OVERRIDE): a set
    // model_override appends `-m <alias>` — validated loud here, before any
    // process exists. Absent override keeps the legacy spawn byte-identical.
    const args =
      this.provider.id === 'kimi'
        ? kimiSpawnArgs(baseArgs, this.options.modelOverride ?? null)
        : baseArgs;
    const spawnEnv: Record<string, string> = {
      // Force a non-interactive, colorless stdio environment. NO_COLOR /
      // FORCE_COLOR strip ANSI escapes; TERM=dumb + CI=true prevent the CLI
      // from attempting a TUI redraw on a pipe.
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
      CI: 'true',
    };
    // K3 thinking effort rides effort_override via env (no CLI flag exists).
    const k3Effort = kimiK3ThinkingEffortEnv(
      this.options.modelOverride ?? null,
      this.options.effort,
      (msg) => console.warn(`[ACP ${this.options.agentName}] ${msg}`),
    );
    if (k3Effort) spawnEnv.KIMI_MODEL_THINKING_EFFORT = k3Effort;
    this.process = new AcpProcess({
      command,
      args,
      cwd: this.options.workDir,
      env: spawnEnv,
    });

    if (this.provider.autoApprove) {
      this.setAutoApprove(true);
    }

    this.process.on('notification', (method: string, params: unknown, id?: number | string) => {
      this.handleNotification(method, params, id);
    });

    this.process.on('stderr', (text: string) => {
      // Kimi dumps internal diagnostics (including -32603 errors) to stderr.
      // Keep them visible in main-process logs even after init so we can diagnose
      // crashes that don't produce a clean exit event.
      const trimmed = text.trim();
      if (trimmed) {
        console.error(`[ACP ${this.options.agentName}] stderr: ${trimmed}`);
      }
      this.emitAcpEvent({ sessionUpdate: 'stderr', sessionId: this.sessionId ?? undefined, text });
    });

    this.process.on('error', (err: Error) => {
      console.error(`[ACP ${this.options.agentName}] process error:`, err);
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? undefined, error: err.message });
      this.scheduleRestart(`process error: ${err.message}`);
    });

    this.process.on('exit', (code: number | null, signal: string | null) => {
      const wasIntentional = this.intentionalKill;
      const wasHealthy = this.initialized;
      this.intentionalKill = false;
      console.warn(`[ACP ${this.options.agentName}] process exited (code=${code}, signal=${signal})`);
      this.stopPromptWatchdog();
      this.process = null;
      this.sessionId = null;
      this.initialized = false;
      void endAgentSession(this.id, 'normal');
      this.emitAcpEvent({
        sessionUpdate: 'error',
        sessionId: this.sessionId ?? undefined,
        error: `ACP process exited (code=${code}, signal=${signal})`,
      });
      // If the runtime died unexpectedly while it was healthy, try to bring it
      // back. Intentional kills (manual restart/quit) and startup-time crashes
      // are handled by the caller.
      if (!wasIntentional && wasHealthy) {
        this.scheduleRestart(`process exited (code=${code}, signal=${signal})`);
      }
    });

    this.process.start();

    // Serialize the initialize handshake across all ACP runtimes to avoid Kimi
    // shared-global-state races that surface as -32603 internal errors.
    const releaseLock = await acquireInitLock();
    let initResult: Record<string, unknown>;
    let sessionResult: Record<string, unknown>;
    let agentCaps: AcpAgentCapabilities = {};
    let resumed = false;
    try {
      initResult = (await this.process.request('initialize', {
        protocolVersion: 1,
        capabilities: this.provider.defaultCapabilities,
        clientInfo: { name: 'acp-desktop', version: '1.0.0' },
      })) as Record<string, unknown>;
      agentCaps = (initResult.agentCapabilities as AcpAgentCapabilities) ?? {};

      // Version floor (WO-ACP-KIMI-NATIVE-IMAGE-PASTE §4): the delegated
      // image pipeline relies on kimi's server-side format gate + compression,
      // which landed in 0.23.5. Below the floor we fail loud instead of
      // silently degrading pasted images. Absent/unparseable versions warn and
      // proceed — don't block startup on a sloppy version string.
      if (this.provider.id === 'kimi') {
        const agentVersion = (initResult.agentInfo as AcpAgentInfo | undefined)?.version;
        const parsed = parseSemver(agentVersion);
        if (parsed && isVersionBelow(parsed, MIN_AGENT_VERSION)) {
          const message = `kimi >= ${MIN_AGENT_VERSION.join('.')} required for image paste / server image gate (found ${agentVersion})`;
          console.error(`[ACP ${this.options.agentName}] ${message}`);
          this.emitAcpEvent({ sessionUpdate: 'error', sessionId: undefined, error: message });
          throw new UnsupportedAgentVersionError(message);
        }
        if (!parsed) {
          console.warn(`[ACP ${this.options.agentName}] could not parse kimi agentInfo.version (${agentVersion ?? 'absent'}); skipping the ${MIN_AGENT_VERSION.join('.')} version floor check`);
        }
      }

      // Resume the prior session when possible. A restart (watchdog, crash,
      // failed turn) must not throw away the agent's working context by
      // starting an empty session/new. Kimi advertises loadSession and
      // implements session/resume (no history replay — the renderer already
      // holds the transcript). Unknown/expired sessions return a JSON-RPC
      // error and fall back to session/new.
      //
      // One-shot resume skip: a busy episode that outlived its retry cap (or
      // the whole idle watchdog budget) rides the resumed session — this
      // start falls back to session/new exactly once, then normal resume
      // behavior resumes. Consumed here so exactly one session-establishment
      // is fresh.
      const skipResume = this.skipResumeOnce;
      this.skipResumeOnce = false;
      if (skipResume && this.lastSessionId && agentCaps.loadSession) {
        console.warn(`[ACP ${this.options.agentName}] skipping session/resume for ${this.lastSessionId} after a wedged agent-busy episode; starting a fresh session`);
      }
      if (!skipResume && this.lastSessionId && agentCaps.loadSession) {
        try {
          await this.process.request('session/resume', {
            sessionId: this.lastSessionId,
            cwd: this.options.workDir,
            mcpServers: [],
          });
          resumed = true;
          console.log(`[ACP ${this.options.agentName}] resumed session ${this.lastSessionId}`);
        } catch (err) {
          console.warn(`[ACP ${this.options.agentName}] session/resume failed for ${this.lastSessionId}; starting a fresh session:`, err);
        }
      }
      if (resumed) {
        sessionResult = { sessionId: this.lastSessionId };
      } else {
        sessionResult = (await this.process.request('session/new', {
          mcpServers: [],
          cwd: this.options.workDir,
        })) as Record<string, unknown>;
      }
    } finally {
      releaseLock();
    }

    this.sessionId = (sessionResult.sessionId as string) ?? null;
    this.lastSessionId = this.sessionId;
    // Persist so an app-level crash/restart (not just a runtime restart) can
    // resume this session on next launch. When resume just succeeded this is
    // a no-op (id unchanged); a fresh session/new self-heals the entry.
    if (this.sessionId) this.persistSessionId(this.sessionId);
    this.resumedLastStart = resumed;
    this.initialized = true;
    this.capabilities = agentCaps;
    // Active model's image-input capability from the session configOptions
    // (kimi-code fork delta). A resumed session carries no configOptions, so
    // imageIn stays unknown and the composer defers to the server gate.
    this.imageIn = extractActiveModelImageIn(sessionResult);
    this.markHealthy();

    if (this.options.agentId != null) {
      void (async () => {
        const result = await startAgentSession(this.id, this.options.agentId!, this.options.projectId);
        if (!result.ok) {
          this.notifySessionStartFailed(result.status, result.message);
        }
      })();
    }

    this.emitAcpEvent({
      sessionUpdate: 'initialized',
      sessionId: this.sessionId ?? '',
      capabilities: this.capabilities,
      agentInfo: (initResult.agentInfo as AcpAgentInfo) ?? { name: this.provider.displayName },
      imageIn: this.imageIn,
    });

    // No `session/list_commands` nudge here: it's not an ACP-spec method, and
    // Kimi (the only ACP provider) pushes `available_commands_update`
    // proactively after `session/new`. Sending it just made the agent log a
    // -32601 "Method not found" to stderr on every startup.

    // Restore the automatic onboarding kickoff that the PTY fallback path
    // has always provided. The ACP path (e.g., `kimi acp`) no longer shows
    // a banner, so the agent would otherwise sit idle until the user typed
    // something manually. Prefer the Wave-D boot prompt when the orchestrator
    // supplies one; otherwise synthesize a code-generated onboarding prompt
    // so we never rely on per-agent markdown files or the "report as" skill.
    //
    // CRITICAL: pre-fetch identity/mail for ACP before the first turn. Kimi's
    // ACP adapter crashes with -32603 if the agent emits a tool call before the
    // session is fully initialized, so we must embed the data instead of asking
    // the agent to curl it on turn one.
    // A resumed session already carries the boot prompt and full conversation
    // history — re-kicking would double-onboard and burn a turn. Only fresh
    // sessions get the full onboarding kickoff.
    const firstStartThisProcess = !this.hasStartedThisProcess;
    this.hasStartedThisProcess = true;
    if (!resumed) {
      let kickoff = this.options.bootPrompt?.trim() ?? '';
      if (!kickoff) {
        try {
          const [profile, unreadCount] = await Promise.all([
            acpApiGetAgentProfile(this.options.agentName),
            acpApiGetUnreadMailCount(this.options.agentName),
          ]);
          console.log(`[ACP] boot prompt data for ${this.options.agentName}: profile=${profile ? 'present' : 'missing'} unread=${unreadCount ?? 'null'}`);
          kickoff = buildAgentBootPrompt(this.options.agentName, {
            profile,
            unreadCount,
            recentContext: this.recentUserPrompts,
          });
        } catch (err) {
          console.warn(`[ACP] failed to pre-fetch boot data for ${this.options.agentName}:`, err);
          kickoff = buildAgentBootPrompt(this.options.agentName, {
            recentContext: this.recentUserPrompts,
          });
        }
      }
      this.systemPrompt(kickoff).catch((err) => {
        console.error(`[ACP] Failed to send onboarding kickoff for ${this.options.agentName}:`, err);
      });
    } else if (firstStartThisProcess) {
      // App-relaunch resume: kimi replays no history on session/resume and the
      // renderer booted blank, so without a wake-up the agent sits silent and
      // never visibly onboards. Send a lightweight nudge — NOT the full boot
      // prompt (context survived; re-onboarding would double it). In-process
      // watchdog restarts skip this: the renderer still holds the transcript.
      let unreadCount: number | null = null;
      try {
        unreadCount = await acpApiGetUnreadMailCount(this.options.agentName);
      } catch (err) {
        console.warn(`[ACP] failed to pre-fetch unread count for ${this.options.agentName} resume nudge:`, err);
      }
      const nudge = buildAgentResumeNudge(this.options.agentName, { unreadCount });
      this.systemPrompt(nudge).catch((err) => {
        console.error(`[ACP] Failed to send resume nudge for ${this.options.agentName}:`, err);
      });
    }
  }

  async prompt(text: string, images?: AcpPromptImage[]): Promise<void> {
    if (!this.process?.isRunning() || !this.sessionId) {
      throw new Error('ACP runtime not initialized');
    }
    this.recordUserPrompt(text);
    // Image blocks ride the same session/prompt after the text block. No
    // client-side format/size validation happens here — kimi's server-side
    // gate (byte-sniff, compress, caption) owns image correctness.
    const prompt: AcpSendContentBlock[] = [{ type: 'text', text }];
    for (const image of images ?? []) {
      prompt.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    }
    await this.sendPrompt(prompt);
  }

  private async systemPrompt(text: string): Promise<void> {
    if (!this.process?.isRunning() || !this.sessionId) {
      throw new Error('ACP runtime not initialized');
    }
    const prompt: AcpSendContentBlock[] = [{ type: 'text', text }];
    await this.sendPrompt(prompt);
  }

  private recordUserPrompt(text: string): void {
    this.recentUserPrompts.push(text);
    if (this.recentUserPrompts.length > this.MAX_PRESERVED_PROMPTS) {
      this.recentUserPrompts.shift();
    }
  }

  /**
   * Inject a mail notice. MAIL NEVER STACKS TURNS (Jon's rule, WO 11622):
   * mid-turn it steers into the active turn (the notice joins the live
   * context); if the runtime can't steer (old adapter, busy-reject), the mail
   * DEFERS — it waits in the inbox and the renderer's catch-up synthesis
   * re-notifies at the next idle/connect. It is never queued behind the turn.
   * Resolves true on delivery, false on defer/failure (the renderer's
   * retry/failure path settles either way, WO 11462).
   */
  async injectMail(text: string): Promise<boolean> {
    if (!this.process?.isRunning() || !this.sessionId) {
      console.warn(`[ACP ${this.options.agentName}] injectMail skipped: runtime not initialized`);
      return false;
    }

    const prompt: AcpSendContentBlock[] = [{ type: 'text', text }];
    this.recordUserPrompt(text);
    if (this.promptInFlight) {
      return this.steerThrough(prompt, { queueOnBusy: false });
    }
    this.executePrompt(prompt);
    return true;
  }

  /**
   * Resolves true once the prompt was actually dispatched to the runtime,
   * false when it never will be (runtime down, or the queue entry was dropped
   * by dropQueuedPrompts). Callers that only care about delivery events can
   * keep ignoring the result; injectMail depends on it (WO 11462).
   */
  private sendPrompt(prompt: AcpSendContentBlock[]): Promise<boolean> {
    if (!this.process?.isRunning() || !this.sessionId) {
      const message = 'ACP runtime not initialized';
      console.error(`[ACP ${this.options.agentName}] ${message}`);
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? '', error: message });
      this.scheduleRestart('runtime not running when prompt sent');
      return Promise.resolve(false);
    }

    if (this.promptInFlight) {
      // Slice B (WO 11585): steer passthrough instead of manager-side
      // queueing. The adapter (steer slice A) absorbs the input into the
      // ACTIVE turn's context at the next step; the turn's own bookkeeping
      // (watchdog, turn_complete) already covers the lifecycle, so this rides
      // WITHOUT touching promptInFlight. Older runtimes that still
      // busy-reject fall back to the classic queue + drain path — and the
      // renderer's queued indicator now means ONLY that backstop state.
      return this.steerThrough(prompt);
    }

    this.executePrompt(prompt);
    return Promise.resolve(true);
  }

  /**
   * Send a prompt through while a turn is in flight. The waiter is tracked in
   * pendingSteers so kill()/dropQueuedPrompts settle it exactly like a queued
   * prompt. A turn.agent_busy rejection means the runtime predates the
   * adapter steer: by default fall back to promptQueue + drain (the ONLY path
   * that still emits prompt_queued); with queueOnBusy:false the prompt
   * defers instead (mail never stacks, WO 11622 — the catch-up synthesis
   * re-notifies at the next idle/connect).
   */
  private steerThrough(
    prompt: AcpSendContentBlock[],
    opts?: { queueOnBusy?: boolean },
  ): Promise<boolean> {
    const sessionId = this.sessionId ?? '';
    const preview = prompt.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ').slice(0, 120);
    console.log(`[ACP ${this.options.agentName}] >>> session/prompt (steer into active turn, session=${sessionId}): ${preview}`);
    const entry: { prompt: AcpSendContentBlock[]; resolve: (dispatched: boolean) => void } = {
      prompt,
      resolve: () => {},
    };
    const promise = new Promise<boolean>((resolve) => {
      entry.resolve = resolve;
    });
    this.pendingSteers.add(entry);
    const done = (dispatched: boolean): boolean => {
      // Settle ONLY while the entry is still ours: after a restart migrates
      // it into promptQueue, the queue's drain owns the settlement — a late
      // rejection/resolution from the OLD process must not false-settle a
      // prompt that is queued to drain (WO 11652).
      if (!this.pendingSteers.delete(entry)) return dispatched;
      entry.resolve(dispatched);
      return dispatched;
    };
    this.process!.request('session/prompt', { sessionId, prompt }, 0)
      .then(() => done(true))
      .catch((err: unknown) => {
        if (isAgentBusyError(err)) {
          if (opts?.queueOnBusy === false) {
            // Deferral path (mail never stacks turns, WO 11622): no queue, no
            // prompt_queued — the mail waits in the inbox and the catch-up
            // synthesis re-notifies at the next idle/connect.
            console.log(`[ACP ${this.options.agentName}] steer unsupported (turn.agent_busy) — deferred to idle catch-up`);
            done(false);
            return;
          }
          console.log(`[ACP ${this.options.agentName}] steer unsupported (turn.agent_busy) — queued behind active turn`);
          this.pendingSteers.delete(entry);
          this.promptQueue.push({ prompt: entry.prompt, resolve: entry.resolve });
          this.emitAcpEvent({
            sessionUpdate: 'prompt_queued',
            sessionId,
            queueDepth: this.promptQueue.length,
          });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ACP ${this.options.agentName}] steer passthrough failed (session=${sessionId}):`, err);
        this.emitAcpEvent({ sessionUpdate: 'error', sessionId, error: message });
        done(false);
      });
    return promise;
  }

  private executePrompt(
    prompt: AcpSendContentBlock[],
    resolveDispatched?: (dispatched: boolean) => void,
    isAgentBusyRetry = false,
  ): void {
    if (!this.process?.isRunning() || !this.sessionId) {
      const message = 'ACP runtime not initialized';
      console.error(`[ACP ${this.options.agentName}] ${message}`);
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? '', error: message });
      this.scheduleRestart('runtime not running when prompt sent');
      resolveDispatched?.(false);
      this.promptInFlight = false;
      this.drainPromptQueue();
      return;
    }

    this.promptInFlight = true;
    resolveDispatched?.(true);
    const sessionId = this.sessionId;
    const preview = prompt.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ').slice(0, 120);
    console.log(`[ACP ${this.options.agentName}] >>> session/prompt (session=${sessionId}): ${preview}`);
    const settledRef = { current: false };
    this.promptSettledRef = settledRef;

    // The inactivity watchdog is the ONLY hang detector. There is no
    // wall-clock ceiling on session/prompt: duration alone must never kill a
    // turn. A fixed ceiling (previously 10 min) killed healthy long-running
    // turns, and the resulting restart wiped the agent's entire session
    // context. Healthy turns keep emitting content-bearing notifications and
    // reset the watchdog; only PROMPT_IDLE_MS of meaningful silence trips it.
    //
    // Agent-busy retries must NOT re-arm: the whole agent_busy episode runs
    // on ONE continuous idle budget (see the turn.agent_busy branch below) —
    // re-arming every 5s would let a wedged busy-turn dodge the watchdog
    // forever.
    if (!isAgentBusyRetry) {
      this.startPromptWatchdog();
    }

    // Send prompt without awaiting — the response arrives as streaming notifications.
    // Pass timeoutMs=0 so the per-request timeout in AcpProcess doesn't fire while
    // a healthy turn is still streaming; the manager-level watchdog handles hangs.
    this.process.request('session/prompt', { sessionId, prompt }, 0)
      .then((result) => {
        if (settledRef.current) return;
        settledRef.current = true;
        this.stopPromptWatchdog();
        this.markHealthy();
        // A dispatch the runtime accepted and resolved ends any busy episode.
        this.agentBusyRejectionCount = 0;
        this.agentBusyCancelSent = false;
        const stopReason =
          typeof (result as Record<string, unknown>)?.stopReason === 'string'
            ? ((result as Record<string, unknown>).stopReason as string)
            : 'end_turn';
        console.log(`[ACP ${this.options.agentName}] <<< session/prompt result (session=${sessionId}): stopReason=${stopReason}`);
        this.emitAcpEvent({
          sessionUpdate: 'turn_complete',
          sessionId,
          stopReason,
        });
        // Visibility aid: log the raw result so we can see what the runtime
        // actually returned when the transcript appears empty.
        console.log(`[ACP ${this.options.agentName}] <<< session/prompt raw result (session=${sessionId}):`, JSON.stringify(result ?? null).slice(0, 2000));
        this.promptInFlight = false;
        this.drainPromptQueue();
      })
      .catch((err) => {
        if (settledRef.current) return;
        settledRef.current = true;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ACP ${this.options.agentName}] session/prompt failed (session=${sessionId}):`, err);
        if (this.process?.isRunning()) {
          if (isAgentBusyError(err)) {
            // turn.agent_busy: a turn the manager believed over is still
            // running at the runtime. Do NOT cancel it (it may be legitimate
            // work — we have no handle proving it is the zombie) and do NOT
            // fail this prompt (its content never executed). Re-queue it at
            // the FRONT with its resolve intact, stay turn-in-flight, and
            // retry dispatch on a short backoff until the busy turn ends.
            //
            // The idle watchdog keeps its existing budget — no re-arm here
            // and none in the retry dispatches (isAgentBusyRetry) — so a
            // genuinely wedged busy-turn still trips PROMPT_IDLE_MS and
            // restarts as today. The busy turn's own notifications keep
            // resetting the clock via handleNotification while it is alive.
            // Consecutive rejections are additionally capped
            // (MAX_AGENT_BUSY_REJECTIONS): on reaching the cap the episode
            // escalates to the same restart a watchdog trip takes, except
            // skipping resume once — a busy condition that outlives the cap
            // is a property of the resumed session.
            this.agentBusyRejectionCount++;
            console.warn(
              `[ACP ${this.options.agentName}] turn.agent_busy — re-queueing prompt and re-syncing (session=${sessionId}, rejection ${this.agentBusyRejectionCount}/${MAX_AGENT_BUSY_REJECTIONS})`,
            );
            this.promptQueue.unshift({ prompt, resolve: resolveDispatched ?? (() => {}) });
            this.promptInFlight = true;
            // The watchdog consults promptSettledRef each tick and stops when
            // it is set — hand it a live ref or the re-sync ends on the next
            // tick. The idle tick count is deliberately NOT reset.
            this.promptSettledRef = { current: false };
            if (this.agentBusyRejectionCount === AGENT_BUSY_CANCEL_AFTER) {
              // A busy turn that outlives a few probes is almost always a
              // zombie left over from a previous incarnation (the process is
              // gone; the session file still thinks the turn is live). Cancel
              // it NOW and keep probing: if the cancel frees the session, the
              // next retry dispatches and the resumed context survives. If the
              // busy turn is real (or the cancel doesn't take), the episode
              // escalates at the cap exactly as before — the cancel the
              // escalation already sends makes this a no-op policy-wise, just
              // early enough to actually do some good.
              console.warn(
                `[ACP ${this.options.agentName}] busy turn survived ${AGENT_BUSY_CANCEL_AFTER} probes — sending session/cancel to free the session`,
              );
              this.process?.notify('session/cancel', { sessionId });
              this.agentBusyCancelSent = true;
            }
            if (this.agentBusyRejectionCount >= MAX_AGENT_BUSY_REJECTIONS) {
              // Cap reached: stop probing and take the watchdog path
              // (failPendingTurn + restart) with a one-shot resume skip —
              // re-resuming the busy session would just re-enter the loop.
              // The early cancel already fired this episode, so no second
              // session/cancel here unless AGENT_BUSY_CANCEL_AFTER never ran.
              // The re-queued prompt stays queued; the fresh-session restart
              // settles it via the usual drop.
              const busyMessage = `${this.options.agentName} still turn.agent_busy after ${this.agentBusyRejectionCount} consecutive rejections; restarting with a fresh session`;
              console.warn(`[ACP ${this.options.agentName}] ${busyMessage}`);
              const cancelNeeded = !this.agentBusyCancelSent;
              this.agentBusyRejectionCount = 0;
              this.agentBusyCancelSent = false;
              this.skipResumeOnce = true;
              if (cancelNeeded) this.process?.notify('session/cancel', { sessionId });
              this.failPendingTurn(busyMessage);
              void this.restart();
              return;
            }
            this.scheduleAgentBusyRetry();
            return;
          }
          // The runtime answered, so the process and session are alive: the
          // failure is scoped to this turn. Cancel the turn, surface the
          // error, and keep the session and prompt queue intact — restarting
          // here would throw away working context for a non-fatal failure.
          // (Kimi's ACP adapter resolves most turn failures as end_turn; a
          // rejection is e.g. an auth error or an SDK-level failure, and its
          // session/cancel resolves the in-flight prompt with 'cancelled' —
          // the settledRef guard above keeps that late resolve from
          // double-emitting turn_complete.)
          console.warn(`[ACP ${this.options.agentName}] cancelling failed turn; keeping session ${sessionId}`);
          // Answered non-busy: any busy re-sync episode is over.
          this.agentBusyRejectionCount = 0;
          this.agentBusyCancelSent = false;
          this.process.notify('session/cancel', { sessionId });
          this.failPendingTurn(message);
          this.drainPromptQueue();
          return;
        }
        // The process is gone, so the session cannot outlive it: surface the
        // error and restart (the next start attempts session/resume via
        // lastSessionId, and restart() drains or visibly drops queued prompts
        // depending on whether the resume succeeded).
        this.stopPromptWatchdog();
        // The busy episode (if any) dies with the process.
        this.agentBusyRejectionCount = 0;
        this.agentBusyCancelSent = false;
        this.emitAcpEvent({ sessionUpdate: 'error', sessionId, error: message });
        this.promptInFlight = false;
        this.scheduleRestart(`session/prompt failed: ${message}`);
      });
  }

  /**
   * User-initiated purge of the queued backlog (WO 11572): after a human
   * interrupt, the messages queued behind it must not drain into the next
   * turn. Settles waiters as not-dispatched (same settle as
   * dropQueuedPrompts) and returns the discarded count for the UI flash.
   */
  purgeQueue(): number {
    const count = this.promptQueue.length + this.pendingSteers.size;
    this.dropQueuedPrompts('purged by user interrupt');
    return count;
  }

  private dropQueuedPrompts(reason: string): void {
    if (this.promptQueue.length === 0 && this.pendingSteers.size === 0) return;
    console.warn(`[ACP ${this.options.agentName}] dropping ${this.promptQueue.length} queued + ${this.pendingSteers.size} steered prompt(s): ${reason}`);
    for (const queued of this.promptQueue) {
      const preview = queued.prompt.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ').slice(0, 80);
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? '', error: `${reason}: ${preview}` });
      // Settle waiters as NOT dispatched. Without this a queued injectMail
      // hung forever and the renderer could show neither the notice echo nor
      // the delivery-failed line (WO 11462 follow-up).
      queued.resolve(false);
    }
    this.promptQueue = [];
    for (const steer of this.pendingSteers) {
      steer.resolve(false);
    }
    this.pendingSteers.clear();
    // No stale "queued" ghosts in the renderer after a queue drop.
    this.emitAcpEvent({ sessionUpdate: 'queue_cleared', sessionId: this.sessionId ?? '' });
  }

  /**
   * Retry dispatch of the front-of-queue prompt after a turn.agent_busy
   * re-sync. The adapter emits no turn_complete for the zombie turn (its
   * original promise settled manager-side long ago), so the manager learns
   * the runtime is free by retrying — or earlier, when an inbound
   * turn_complete arrives mid-episode (see probeAgentBusyRetryNow). Each
   * retry that is rejected agent_busy again re-queues and re-schedules. The
   * episode is bounded by MAX_AGENT_BUSY_REJECTIONS consecutive rejections
   * (escalation in executePrompt's catch), with the 300s idle watchdog as
   * backstop (its clock is never reset by these retries — see executePrompt's
   * isAgentBusyRetry flag).
   */
  private scheduleAgentBusyRetry(): void {
    if (this.agentBusyRetryTimer) return;
    this.agentBusyRetryTimer = setTimeout(() => {
      this.agentBusyRetryTimer = null;
      this.runAgentBusyRetryProbe();
    }, AGENT_BUSY_RETRY_MS);
  }

  /**
   * An inbound turn_complete while a busy retry is pending means the busy
   * turn just ended: cancel the pending retry timer and probe immediately
   * instead of waiting out the tick. No-op unless a retry is actually armed,
   * so ordinary turn completions never cause extra dispatches.
   */
  private probeAgentBusyRetryNow(): void {
    if (!this.agentBusyRetryTimer) return;
    clearTimeout(this.agentBusyRetryTimer);
    this.agentBusyRetryTimer = null;
    this.runAgentBusyRetryProbe();
  }

  private runAgentBusyRetryProbe(): void {
    // Release the in-flight flag so executePrompt can take ownership of the
    // re-queued prompt. If the runtime is still busy, the catch branch
    // re-queues and re-schedules.
    this.promptInFlight = false;
    const next = this.promptQueue.shift();
    if (!next) {
      // Nothing left to re-dispatch — the episode is over.
      this.agentBusyRejectionCount = 0;
      this.agentBusyCancelSent = false;
      return;
    }
    console.log(`[ACP ${this.options.agentName}] retrying dispatch after turn.agent_busy (session=${this.sessionId})`);
    this.emitAcpEvent({
      sessionUpdate: 'prompt_dequeued',
      sessionId: this.sessionId ?? '',
      queueDepth: this.promptQueue.length,
    });
    this.executePrompt(next.prompt, next.resolve, true);
  }

  private drainPromptQueue(): void {
    if (!this.process?.isRunning() || !this.sessionId) {
      // Runtime is down (likely restarting after an error). Fail any queued
      // prompts so the user sees feedback rather than an eternal spinner.
      this.dropQueuedPrompts('runtime not initialized');
      return;
    }

    const next = this.promptQueue.shift();
    if (next) {
      console.log(`[ACP ${this.options.agentName}] draining prompt queue (remaining=${this.promptQueue.length}, session=${this.sessionId})`);
      this.emitAcpEvent({
        sessionUpdate: 'prompt_dequeued',
        sessionId: this.sessionId ?? '',
        queueDepth: this.promptQueue.length,
      });
      this.executePrompt(next.prompt, next.resolve);
    }
  }

  cancel(): void {
    const sessionId = this.sessionId;
    if (this.process && sessionId) {
      this.process.notify('session/cancel', { sessionId });
    }
    // Always emit turn_complete so the renderer clears the activity spinner,
    // even if the runtime process has already crashed and the cancel notify
    // could not be delivered.
    this.emitAcpEvent({
      sessionUpdate: 'turn_complete',
      sessionId: sessionId ?? '',
      stopReason: 'cancelled',
    });
  }

  setMode(mode: string): void {
    if (!this.process || !this.sessionId) return;
    this.process.notify('session/set_mode', { sessionId: this.sessionId, modeId: mode });
  }

  kill(opts?: { preserveQueue?: boolean }): void {
    this.intentionalKill = true;
    this.stopPromptWatchdog();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.agentBusyRetryTimer) {
      clearTimeout(this.agentBusyRetryTimer);
      this.agentBusyRetryTimer = null;
    }
    // Any busy episode ends with the runtime. skipResumeOnce deliberately
    // survives kill() — restart() calls kill() before start(), and startOnce()
    // still needs the flag.
    this.agentBusyRejectionCount = 0;
    this.agentBusyCancelSent = false;
    if (!opts?.preserveQueue) {
      // An intentional kill gives queued prompts no later drain path — settle
      // them NOW (dispatched=false) so waiters (e.g. a queued mail inject)
      // resolve instead of hanging forever (WO 11483). restart() preserves the
      // queue and decides itself (drain on resume, drop on fresh session).
      // Done BEFORE the process check: a dead process with a non-empty queue
      // still owes those waiters a settlement.
      this.dropQueuedPrompts('runtime killed');
    }
    if (!this.process) return;
    this.process.kill('SIGTERM');
    this.process = null;
    this.sessionId = null;
    this.initialized = false;
    void endAgentSession(this.id, 'normal');
  }

  async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    console.log(`[ACP ${this.options.agentName}] Restarting runtime`);
    this.kill({ preserveQueue: true });
    // Brief pause so the OS can release stdio handles / file locks before we
    // spawn a replacement (especially important on Windows).
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await this.start();
      this.markHealthy();
      console.log(`[ACP ${this.options.agentName}] Runtime restarted`);
      if (this.promptQueue.length > 0 || this.pendingSteers.size > 0) {
        if (this.resumedLastStart) {
          // Context survived the restart — queued prompts still make sense,
          // and steered prompts must be re-dispatched: the turn they were
          // steered into died with the old process.
          for (const steer of this.pendingSteers) {
            this.promptQueue.push({ prompt: steer.prompt, resolve: steer.resolve });
          }
          this.pendingSteers.clear();
          console.log(`[ACP ${this.options.agentName}] session resumed; draining ${this.promptQueue.length} queued prompt(s)`);
          this.drainPromptQueue();
        } else {
          // Fresh session: queued prompts were written against context that no
          // longer exists. Fail them visibly instead of sending them into an
          // empty session.
          this.dropQueuedPrompts('runtime restarted with a fresh session');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ACP ${this.options.agentName}] Runtime restart failed:`, err);
      this.emitAcpEvent({
        sessionUpdate: 'error',
        sessionId: this.sessionId ?? '',
        error: `Runtime restart failed: ${message}`,
      });
      this.scheduleRestart(`restart failed: ${message}`);
    } finally {
      this.restarting = false;
    }
  }

  private scheduleRestart(reason: string): void {
    if (this.restartTimer) return;
    if (this.restartCount >= this.MAX_RESTARTS) {
      const message = `Runtime keeps failing (${this.restartCount} restarts): ${reason}`;
      console.error(`[ACP ${this.options.agentName}] ${message}`);
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? '', error: message });
      // No restart is coming — settle the queue so waiters resolve false
      // instead of hanging forever (WO 11483).
      this.dropQueuedPrompts('restart budget exhausted');
      return;
    }
    this.restartCount++;
    const delay = Math.min(30_000, 1_000 * Math.pow(2, this.restartCount - 1));
    console.warn(`[ACP ${this.options.agentName}] scheduling restart #${this.restartCount} in ${delay}ms: ${reason}`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restart();
    }, delay);
  }

  private markHealthy(): void {
    if (this.restartCount > 0) {
      console.log(`[ACP ${this.options.agentName}] runtime healthy; reset restart counter`);
      this.restartCount = 0;
    }
  }

  respondToPermission(requestId: number | string, optionId: string, outcome = 'selected'): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      pending.resolve(optionId);
      this.pendingPermissions.delete(requestId);
      return;
    }
    // If no pending renderer approval, send directly.
    this.sendPermissionResponse(requestId, optionId, outcome);
  }

  private handleNotification(method: string, params: unknown, id?: number | string): void {
    if (method === 'session/request_permission') {
      // Interactive inbound request: the runtime is alive and waiting on us.
      this.markPromptActivity();
      this.handlePermissionRequest({ jsonrpc: '2.0', id, method, params });
      return;
    }

    if (method !== 'session/update' || !params || typeof params !== 'object') return;
    const updateParams = params as Record<string, unknown>;
    const update = updateParams.update as Record<string, unknown> | undefined;
    if (!update) return;

    const sessionUpdate = update.sessionUpdate as string;
    // Only content-bearing updates count as turn activity. Anything else
    // (keepalives, lifecycle chatter, unknown update types) must not reset
    // the idle watchdog: a runtime that streams noise while producing nothing
    // is hung and has to trip PROMPT_IDLE_MS.
    if (MEANINGFUL_SESSION_UPDATES.has(sessionUpdate)) {
      // A wait_state frame counts only when it actually parses — a malformed
      // frame is dropped from the UI and must not feed the idle budget
      // (WO 11498 hardening).
      if (sessionUpdate !== 'wait_state' || parseWaitState(update) != null) {
        this.markPromptActivity();
      }
    }
    const sessionId = (updateParams.sessionId as string) ?? this.sessionId ?? '';
    // Skip logging high-frequency streaming updates — they fire per token or
    // per tool-progress tick and flood the terminal. One-shot lifecycle
    // updates (tool_call, turn_complete, plan, ...) stay logged.
    if (!NOISY_SESSION_UPDATES.has(sessionUpdate)) {
      console.log(`[ACP ${this.options.agentName}] notification: ${sessionUpdate}`);
    }

    switch (sessionUpdate) {
      case 'available_commands_update': {
        const availableCommands = (update.availableCommands as Array<{ name: string; description: string }>) ?? [];
        this.emitAcpEvent({ sessionUpdate: 'available_commands_update', sessionId, availableCommands });
        break;
      }
      case 'agent_thought_chunk': {
        const content = extractContent(update.content);
        if (content) this.emitAcpEvent({ sessionUpdate: 'agent_thought_chunk', sessionId, content });
        break;
      }
      case 'agent_message_chunk': {
        const content = extractContent(update.content);
        if (content) this.emitAcpEvent({ sessionUpdate: 'agent_message_chunk', sessionId, content });
        break;
      }
      case 'tool_call': {
        const toolCall = parseToolCall(update);
        if (toolCall) this.emitAcpEvent({ sessionUpdate: 'tool_call', sessionId, toolCall });
        break;
      }
      case 'tool_call_update': {
        const toolCall = parseToolCall(update);
        if (toolCall) this.emitAcpEvent({ sessionUpdate: 'tool_call_update', sessionId, toolCall });
        break;
      }
      case 'turn_complete': {
        const stopReason = (update.stopReason as string) ?? 'unknown';
        this.emitAcpEvent({ sessionUpdate: 'turn_complete', sessionId, stopReason });
        // Mid busy-episode this is the signal that the busy turn ended —
        // probe the re-queued prompt now instead of waiting for the tick.
        this.probeAgentBusyRetryNow();
        break;
      }
      case 'wait_state': {
        // Wait-state frames (kimi-code ≥0.27.0) report what the runtime is
        // waiting on — provider first-token latency or retry backoff with
        // advancing attempt counters. They count as meaningful activity (see
        // MEANINGFUL_SESSION_UPDATES) and are forwarded for the UI.
        const waitState = parseWaitState(update);
        if (waitState) this.emitAcpEvent({ sessionUpdate: 'wait_state', sessionId, waitState });
        break;
      }
      default:
        // Ignore unknown update types safely.
        break;
    }
  }

  private handlePermissionRequest(message: AcpJsonRpcMessage): void {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const options = (params.options as AcpPermissionOption[]) ?? [];
    const toolCall = parseToolCall(params.toolCall as Record<string, unknown>) ?? {
      toolCallId: 'unknown',
      title: 'Permission request',
      status: 'in_progress',
      content: [],
    };
    const requestId = message.id ?? 'unknown';

    if (this.autoApprove) {
      const allowAlways = options.find((o) => o.kind === 'allow_always');
      const allowOnce = options.find((o) => o.kind === 'allow_once');
      const optionId = allowAlways?.optionId ?? allowOnce?.optionId ?? options[0]?.optionId ?? 'reject';
      this.sendPermissionResponse(requestId, optionId);
      return;
    }

    // Defer to renderer for explicit approval.
    this.pendingPermissions.set(requestId, {
      requestId,
      resolve: (optionId) => this.sendPermissionResponse(requestId, optionId),
    });

    this.emitAcpEvent({
      sessionUpdate: 'permission_request',
      sessionId: this.sessionId ?? '',
      requestId,
      options,
      toolCall,
    });
  }

  private sendPermissionResponse(
    requestId: number | string,
    optionId: string,
    outcome = 'selected',
  ): void {
    if (!this.process) return;
    // Live kimi acp requires a JSON-RPC *response* (matching the request id)
    // with result.outcome as an object, not a flat result or method call.
    this.process.respond(requestId, {
      outcome: {
        outcome,
        optionId,
      },
    });
  }

  private notifySessionStartFailed(status: number | undefined, message: string): void {
    const payload: AgentSessionStartFailedPayload = {
      agentName: this.options.agentName,
      terminalId: this.id,
      status,
      message,
    };
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.AGENT_SESSION_START_FAILED, payload);
      }
    });
  }

  private emitAcpEvent(update: AcpSessionUpdate): void {
    const payload: AcpEventPayload = {
      agent: this.options.agentName,
      sessionId: this.sessionId ?? '',
      update,
    };
    this.emit('event', payload);
  }
}

/** Streaming update types that fire too often to log line-by-line. */
const NOISY_SESSION_UPDATES = new Set([
  'agent_thought_chunk',
  'agent_message_chunk',
  'tool_call_update',
]);

/**
 * session/update types that prove the runtime is producing real turn output.
 * Only these reset the inactivity watchdog (see handleNotification). Kimi's
 * ACP adapter sends no keepalive frames, so anything outside this set is
 * lifecycle chatter, not progress.
 *
 * `wait_state` is meaningful by construction: it is emitted only by a live
 * event loop (provider first-token waits and retry backoffs), it carries
 * advancing attempt/delay data rather than repeating noise, and the retry
 * loop is bounded (maxAttempts) — exhaustion surfaces an error that settles
 * the prompt. A wedged runtime cannot emit it, so accepting it does not
 * reintroduce the chatty-but-dead hole.
 */
const MEANINGFUL_SESSION_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'turn_complete',
  'wait_state',
]);

function extractContent(content: unknown): AcpContentBlock | null {
  if (!content) return null;

  // Already nested ACP content block.
  if (
    typeof content === 'object' &&
    (content as Record<string, unknown>).type === 'content' &&
    (content as Record<string, unknown>).content
  ) {
    const inner = (content as Record<string, unknown>).content as Record<string, unknown>;
    if (inner.type === 'text') {
      return { type: 'content', content: { type: 'text', text: sanitizeAcpDisplayText(String(inner.text ?? '')) } };
    }
    if (inner.type === 'image') {
      return {
        type: 'content',
        content: {
          type: 'image',
          data: String(inner.data ?? ''),
          mimeType: String(inner.mimeType ?? inner.media_type ?? 'image/png'),
        },
      };
    }
    return null;
  }

  // Plain string fallback (legacy or simplified transport).
  if (typeof content === 'string') {
    return { type: 'content', content: { type: 'text', text: sanitizeAcpDisplayText(content) } };
  }

  // Flat text object fallback.
  if (typeof content === 'object' && (content as Record<string, unknown>).text !== undefined) {
    return {
      type: 'content',
      content: { type: 'text', text: sanitizeAcpDisplayText(String((content as Record<string, unknown>).text)) },
    };
  }

  return null;
}

function parseToolCall(update: Record<string, unknown>): AcpToolCall | null {
  const toolCallId = (update.toolCallId as string) ?? '';
  const title = (update.title as string) ?? 'Tool';
  const status = (update.status as AcpToolCall['status']) ?? 'in_progress';
  const rawContent = update.content;

  const content: AcpContentBlock[] = [];
  if (Array.isArray(rawContent)) {
    for (const item of rawContent) {
      const coerced = extractContent(item);
      if (coerced) content.push(coerced);
    }
  }

  if (!toolCallId) return null;
  return { toolCallId, title, status, content };
}

/**
 * Coerce a raw `wait_state` update payload into an {@link AcpWaitState}.
 * `kind` is required (open string — newer runtimes may add kinds); the
 * retry counters are carried only when they are finite numbers so a
 * malformed frame degrades to a plain "waiting" indicator instead of
 * poisoning the UI with NaN.
 */
function parseWaitState(update: Record<string, unknown>): AcpWaitState | null {
  if (typeof update.kind !== 'string' || update.kind.length === 0) return null;
  const numeric = (key: string): number | undefined => {
    const value = update[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  return {
    kind: update.kind,
    failedAttempt: numeric('failedAttempt'),
    nextAttempt: numeric('nextAttempt'),
    maxAttempts: numeric('maxAttempts'),
    delayMs: numeric('delayMs'),
    errorName: typeof update.errorName === 'string' ? update.errorName : undefined,
    statusCode: numeric('statusCode'),
  };
}

/** Delay between re-dispatch attempts after a turn.agent_busy re-sync. */
const AGENT_BUSY_RETRY_MS = 5_000;

/**
 * Consecutive turn.agent_busy rejections that bound one busy episode (≈60s
 * of probing at AGENT_BUSY_RETRY_MS). On reaching it the episode escalates to
 * the watchdog path — best-effort cancel + failPendingTurn + restart — with a
 * one-shot resume skip: a busy condition that outlives the cap is a property
 * of the resumed session, so the restart falls back to session/new.
 */
const MAX_AGENT_BUSY_REJECTIONS = 12;

/**
 * Consecutive busy rejections after which the episode sends a best-effort
 * session/cancel while continuing to probe (≈15s in at AGENT_BUSY_RETRY_MS).
 * A busy turn at resume is usually a zombie from a previous incarnation —
 * cancelling it early frees the session so the resumed context survives;
 * the capped escalation remains the fallback for a turn the cancel can't
 * clear. Fires exactly once per episode (rejection count resets on success,
 * non-busy failure, escalation, or process death).
 */
const AGENT_BUSY_CANCEL_AFTER = 3;

/**
 * Detect a turn.agent_busy rejection. AcpProcess flattens JSON-RPC errors to
 * `<message> (code <n>)`, so the structured `data.code: 'turn.agent_busy'`
 * does not survive to here — match the literal when it does (defensive) and
 * the adapter's canonical busy message otherwise.
 */
function isAgentBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /turn\.agent_busy/i.test(message) ||
    /cannot launch a new turn while another turn/i.test(message)
  );
}
