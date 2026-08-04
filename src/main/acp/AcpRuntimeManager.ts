import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';
import {
  type AcpAgentCapabilities,
  type AcpAgentInfo,
  type AcpContentBlock,
  type AcpEventPayload,
  type AcpMailInjectResult,
  type AcpPermissionOption,
  type AcpPromptImage,
  type AcpSendContentBlock,
  type AcpSessionUpdate,
  type AcpToolCall,
  type AcpWaitState,
} from '../../shared/acpTypes';
import { IPC_CHANNELS, type AgentSessionStartFailedPayload, type TerminalProvider } from '../../shared/types';
import { AcpProcess, type AcpJsonRpcMessage } from './AcpProcess';
import { ClaudeStreamJsonProcess } from './ClaudeStreamJsonProcess';
import { sanitizeAcpDisplayText } from '../../shared/acpSanitize';
import {
  claudeModelArgs,
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
  private process: AcpProcess | ClaudeStreamJsonProcess | null = null;
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
  // Watchdog ladder state (cancel-first, kill-last + throttle-aware grace).
  // cancelGraceTicksLeft non-null: a session/cancel is out and the stalled
  // turn has that many ticks to settle before the restart escalates.
  // stalledTurnNudgePending arms the post-settle resume nudge (same process,
  // context intact). lastThrottleAt/throttleExtensions drive the provider-
  // throttle extension: recent 429/quota evidence on stderr means the silence
  // is the provider's, not a wedge — restarting into a rate limit spawns a
  // fresh CLI straight into the same wall (the restart churn IS the bog-down).
  private cancelGraceTicksLeft: number | null = null;
  private stalledTurnNudgePending = false;
  private lastThrottleAt: number | null = null;
  private throttleExtensions = 0;

  // Kimi's ACP runtime does not handle concurrent session/prompt requests on
  // the same session; overlapping calls produce -32603 internal errors and can
  // cause the in-flight turn to return an empty end_turn. Queue prompts so only
  // one is ever in flight at a time. Entries are tagged by lane: 'human'
  // prompts are the ones the reply-turn nudge may fold into itself (see
  // takeQueuedHumanTexts); 'system' prompts (nudges, kickoffs) always dispatch
  // as their own turn.
  private promptQueue: Array<{ prompt: AcpSendContentBlock[]; resolve: (dispatched: boolean) => void; kind: 'human' | 'system'; replyNudge?: boolean }> = [];
  // Prompts sent THROUGH into the active turn (slice B steer passthrough).
  // Tracked (with their prompt) so kill()/dropQueuedPrompts can settle their
  // waiters exactly like queued prompts — and so a resumed restart can
  // re-dispatch them (the turn they rode died with the old process).
  private pendingSteers = new Set<{ prompt: AcpSendContentBlock[]; resolve: (dispatched: boolean) => void; kind: 'human' | 'system' }>();
  private promptInFlight = false;
  // Mail that arrived while a turn was live, awaiting a single summary offer
  // when this agent next goes idle. See offerDeferredMail() for why this is
  // NOT the WO 11473 backlog synthesis that was deleted 2026-08-01.
  private deferredMailHeaders: string[] = [];
  private deferredMailOverflow = 0;
  private readonly MAX_DEFERRED_MAIL_LINES = 5;
  // Human-reply backstop (NGTMI: "the team lead ignores me"). A human prompt
  // mid-turn STEERS in to influence the live task — but text only posts at
  // turn end, so a perpetually-busy agent (mail storms, long tool chains)
  // never owes the human a reply. The FIRST human steer of a busy episode
  // arms this two-stage timer (later steers don't extend the deadline):
  //   1. HUMAN_REPLY_WARN_MS — a warning steer asks the agent to close its
  //      step and answer; the task list survives because the agent ends its
  //      OWN turn cleanly (Jon's preference: don't shut the task down).
  //   2. HUMAN_REPLY_GRACE_MS — last resort: session/cancel + a front-of-queue
  //      nudge that TELLS the agent it was cut off and to resume after
  //      answering.
  private humanWaitWarnTimer: ReturnType<typeof setTimeout> | null = null;
  private humanWaitTimer: ReturnType<typeof setTimeout> | null = null;
  // True while the backstop's own reply-turn nudge is the active turn. The
  // grace cancel must never fire against it — that turn IS the reply the
  // human is waiting for (see armHumanWaitBackstop).
  private replyTurnActive = false;
  // Learned runtime capability. The kimi TUI has two distinct primitives for
  // input during a busy turn — Esc interrupts (cancel), Ctrl+S steers (pushes
  // up into the live turn) — but the ACP wire only has session/prompt, and
  // kimi's adapter (≤0.31.x) busy-rejects it mid-turn (turn.agent_busy): the
  // Ctrl+S equivalent does not exist on ACP. The FIRST busy-rejected steer
  // flips this flag; afterwards human prompts queue directly instead of
  // attempting a doomed steer, the stage-1 warning steer is skipped (it could
  // only ever be rejected), and the grace-cancel nudge carries the queued
  // human text — otherwise the agent is told to answer a message it never
  // received, and the backlog drains one stale message per turn.
  private steerUnsupported = false;

  // Crash-recovery state. We track whether a kill was intentional so an
  // unexpected process exit can auto-restart, and we back off so a repeatedly
  // crashing runtime (e.g., Kimi cold-init race on Windows) doesn't spin forever.
  private intentionalKill = false;
  // A cancel was delivered to a live runtime, so the child is on its way down
  // and a restart is expected. Distinct from restartTimer, which is only set
  // once the exit has actually been processed — the queue drain runs BEFORE
  // that, which is how queued prompts were being dropped for a restart that
  // was already inevitable.
  private cancelExpectingRestart = false;
  private restarting = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly MAX_RESTARTS = 5;
  // Cause of death of the LAST runtime process, recorded at every site that
  // takes one down (exit, process error, start failure, kill). "ACP runtime
  // not initialized" on its own says nothing about WHY the runtime was gone —
  // reported repeatedly (2026-08-03/04) with no way to tell a crash from a
  // watchdog kill from a session that never established. Every down-runtime
  // log line now carries this plus describeRuntimeState().
  private lastDownReason: { reason: string; at: number } | null = null;

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

        // Stage A grace: the cancel is already out — count down, then escalate
        // to the kill+restart a genuinely hung runtime needs.
        if (this.cancelGraceTicksLeft != null) {
          this.cancelGraceTicksLeft--;
          if (this.cancelGraceTicksLeft > 0) return;
          this.cancelGraceTicksLeft = null;
          this.stalledTurnNudgePending = false;
          this.promptSettledRef!.current = true;
          const message = `No response from ${this.options.agentName} for ${Math.round((this.promptIdleTicks * WATCHDOG_INTERVAL_MS) / 1000)}s and session/cancel went unanswered; restarting runtime`;
          console.warn(`[ACP ${this.options.agentName}] ${message}`);
          // A busy re-sync episode that consumed the whole idle budget will not
          // be fixed by re-resuming the same session: the next start falls back
          // to session/new exactly once (same one-shot skip as the busy-cap
          // escalation in executePrompt).
          if (this.agentBusyRejectionCount > 0) {
            this.agentBusyRejectionCount = 0;
            this.agentBusyCancelSent = false;
            this.skipResumeOnce = true;
          }
          this.sendSessionCancel(this.sessionId);
          this.failPendingTurn(message);
          void this.restart();
          return;
        }

        // Stage C: the silence is the PROVIDER's (recent 429/quota evidence on
        // stderr), not a wedge. Restarting into a rate limit spawns a fresh
        // CLI straight into the same wall — bounded full-budget extensions
        // instead, with the throttle state shown on the pane.
        const throttleFresh =
          this.lastThrottleAt != null && Date.now() - this.lastThrottleAt < THROTTLE_EVIDENCE_FRESH_MS;
        if (throttleFresh && this.throttleExtensions < MAX_THROTTLE_EXTENSIONS) {
          this.throttleExtensions++;
          this.promptIdleTicks = 0;
          const message = `silent ${Math.round(PROMPT_IDLE_MS / 1000)}s but provider is throttling (429/quota on stderr) — extending grace ${this.throttleExtensions}/${MAX_THROTTLE_EXTENSIONS}, no restart`;
          console.warn(`[ACP ${this.options.agentName}] ${message}`);
          this.emitAcpEvent({
            sessionUpdate: 'wait_state',
            sessionId: this.sessionId ?? '',
            waitState: {
              kind: 'provider_retry',
              errorName: `throttling (429/quota) — grace ${this.throttleExtensions}/${MAX_THROTTLE_EXTENSIONS}`,
            },
          });
          return;
        }

        // Stage A: cancel-first. A merely-slow runtime honors the cancel and
        // settles — the settle path then re-orients it with STALLED_TURN_NUDGE
        // (same process, context intact, NO restart). A truly hung runtime
        // ignores the cancel and the next ticks escalate above.
        this.cancelGraceTicksLeft = WATCHDOG_CANCEL_GRACE_TICKS;
        this.stalledTurnNudgePending = true;
        console.warn(
          `[ACP ${this.options.agentName}] no response for ${Math.round((this.promptIdleTicks * WATCHDOG_INTERVAL_MS) / 1000)}s while a turn was pending — sent session/cancel; restarting only if unanswered for ${(WATCHDOG_CANCEL_GRACE_TICKS * WATCHDOG_INTERVAL_MS) / 1000}s`,
        );
        this.sendSessionCancel(this.sessionId);
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
      // Activity means the stall (if any) ended — the throttle-extension
      // budget is per-stall, not per-process-lifetime.
      this.throttleExtensions = 0;
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
        this.recordDown(`start attempt ${attempt}/${maxAttempts} failed: ${lastErr.message}`);
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
    let args =
      this.provider.id === 'kimi'
        ? kimiSpawnArgs(baseArgs, this.options.modelOverride ?? null)
        : baseArgs;
    // Claude pins its session at SPAWN time (`--resume <id>` / `--session-id
    // <uuid>`) — there is no session/new or session/resume verb on the wire, so
    // the decision has to be made here, before the child exists. Mirror the
    // resume-vs-fresh decision the handshake makes below: PEEK skipResumeOnce
    // (that flow consumes it) so both land on the same session. The adapter
    // always advertises loadSession, so the agentCaps half of that test is
    // constant-true for claude.
    if (this.provider.id === 'claude') {
      // Claude session RESTORE is not supported yet, so every claude boot is a
      // FRESH session by construction: always --session-id, NEVER --resume (even
      // on a watchdog restart where lastSessionId is in memory). Paired with
      // loadSession:false in the adapter; re-enable resume in both places
      // together once restore works.
      //
      // Per-agent effort, threaded ONLY when the agent actually carries one.
      // `--effort <level>` is real (Claude Code 2.1.220, "Effort level for the
      // current session") — this is not a revert of that. But the previous
      // `?? 'high'` invented a level nobody set and so put the flag on EVERY
      // claude spawn, which turned a stale CLI into a total outage: the Mac
      // sat on 2.1.19 (~200 releases behind, no such flag), all seven agents
      // died `error: unknown option '--effort'` exit 1 before emitting a byte,
      // and the restart ladder relaunched into the same death — while every
      // agent on the team was effort_override:null and nobody had tuned
      // anything. Absent an override the flag is absent, so a stale CLI can
      // only break agents that genuinely carry one. Do not reinstate the
      // fallback, and do not route claude effort through kimi's channel
      // (KIMI_MODEL_THINKING_EFFORT / effort_override, below) — claude
      // settings are not translated into kimi settings.
      const effort = this.options.effort;
      // Per-agent claude model override rides Claude Code's own `--model`. A
      // stale/cross-runtime id (e.g. a kimi 'k3' on a now-claude placement) is
      // ignored → default model, matching the retired TUI path; only a real
      // claude model is passed. kimi's -m alias path is separate.
      const modelArgs = claudeModelArgs(
        this.options.modelOverride,
        (m) => console.warn(`[ACP ${this.options.agentName}] ${m}`),
      );
      // Resume RE-ENABLED for claude (2026-08-03). Cancel on this path is a
      // process kill — `-p` has no cancel verb — so under fresh-session-only
      // every brake was a lobotomy: Esc AND the 60s human-wait backstop each
      // cost the agent its entire context plus a re-onboarding turn. A
      // keystroke must never restart a session; that is what the button is
      // for. Kill+resume means you lose the TURN and keep the AGENT.
      // Verified live: cancel and full app restart both come back on the same
      // session id with no new session minted.
      const willResume = !this.skipResumeOnce && !!this.lastSessionId;
      args = [
        ...args,
        ...(effort ? ['--effort', effort] : []),
        ...modelArgs,
        ...(willResume ? ['--resume', this.lastSessionId!] : ['--session-id', randomUUID()]),
      ];
    }
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
    // Claude speaks stream-json, not ACP JSON-RPC; ClaudeStreamJsonProcess is
    // the shim that presents the AcpProcess surface over that wire.
    this.process =
      this.provider.id === 'claude'
        ? new ClaudeStreamJsonProcess({
            command,
            args,
            cwd: this.options.workDir,
            env: spawnEnv,
          })
        : new AcpProcess({
            command,
            args,
            cwd: this.options.workDir,
            env: spawnEnv,
          });

    // Developer visibility (Jon's ask): show the exact launch command —
    // overrides included — as a banner line in the pane, the way the old PTY
    // shell echo did. Emitted on every (re)spawn so a restart with
    // re-resolved overrides is visible too.
    this.emitAcpEvent({
      sessionUpdate: 'spawn_info',
      command: `${command} ${args.join(' ')}${k3Effort ? `  KIMI_MODEL_THINKING_EFFORT=${k3Effort}` : ''}`,
    });

    if (this.provider.autoApprove) {
      this.setAutoApprove(true);
    }

    this.process.on('notification', (method: string, params: unknown, id?: number | string) => {
      this.handleNotification(method, params, id);
    });

    // Claude's adapter emits ALREADY-MAPPED updates on 'sessionUpdate' (kimi
    // uses 'notification' -> handleNotification). Forward them straight to
    // emitAcpEvent — re-mapping them would mangle them. Never fires for kimi.
    this.process.on('sessionUpdate', (update: AcpSessionUpdate) => {
      // Per-agent effort is a spawn arg the manager owns, not something in the
      // stream — stamp it onto the mapper's 'initialized' agentInfo so the
      // footer can show it. Claude-only (this path never fires for kimi, and
      // effort is a claude-only knob). The store MERGES agentInfo, so this
      // survives the synthetic handshake's barer 'initialized'.
      if (update.sessionUpdate === 'initialized' && update.agentInfo && this.options.effort) {
        update = { ...update, agentInfo: { ...update.agentInfo, effort: this.options.effort } };
      }
      this.emitAcpEvent(update);
    });

    this.process.on('stderr', (text: string) => {
      // Kimi dumps internal diagnostics (including -32603 errors) to stderr.
      // Keep them visible in main-process logs even after init so we can diagnose
      // crashes that don't produce a clean exit event.
      const trimmed = text.trim();
      if (trimmed) {
        console.error(`[ACP ${this.options.agentName}] stderr: ${trimmed}`);
      }
      // Provider-throttle evidence (429/quota/backoff): the watchdog's
      // throttle extension reads this to wait out provider stalls instead of
      // restarting into the same wall.
      if (THROTTLE_STDERR_PATTERN.test(text)) {
        if (this.lastThrottleAt == null || Date.now() - this.lastThrottleAt >= THROTTLE_EVIDENCE_FRESH_MS) {
          console.warn(`[ACP ${this.options.agentName}] provider throttle evidence on stderr — watchdog will extend grace instead of restarting`);
        }
        this.lastThrottleAt = Date.now();
      }
      this.emitAcpEvent({ sessionUpdate: 'stderr', sessionId: this.sessionId ?? undefined, text });
    });

    this.process.on('error', (err: Error) => {
      console.error(`[ACP ${this.options.agentName}] process error:`, err);
      this.recordDown(`process error: ${err.message}`);
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? undefined, error: err.message });
      this.scheduleRestart(`process error: ${err.message}`);
    });

    this.process.on('exit', (code: number | null, signal: string | null) => {
      const wasIntentional = this.intentionalKill;
      const wasHealthy = this.initialized;
      // A cancel we sent is a kill we asked for — recoverable by definition,
      // whatever `initialized` says by the time the exit lands.
      const wasCancelled = this.cancelExpectingRestart;
      this.intentionalKill = false;
      // Record BEFORE the state is torn down, and name the flavour of exit —
      // "intentional" (kill/restart), "cancelled" (a cancel we sent, which on
      // claude IS the kill) and "unexpected" send a prompt down very different
      // paths, and after the fact they are indistinguishable in the logs.
      const flavour = wasIntentional ? 'intentional' : wasCancelled ? 'after-cancel' : 'unexpected';
      this.recordDown(
        `process exited (code=${code}, signal=${signal}, ${flavour}, wasInitialized=${wasHealthy}, midTurn=${this.promptInFlight})`,
      );
      console.warn(
        `[ACP ${this.options.agentName}] process exited (code=${code}, signal=${signal}, ${flavour}) — ${this.describeRuntimeState()}`,
      );
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
      // `wasHealthy` reads `initialized`, which an earlier exit may already
      // have cleared — that is how a cancelled runtime ended up with nothing
      // scheduled to bring it back, dead until a human restarted the pane.
      // An exit that FOLLOWS a cancel is always recoverable: the cancel was a
      // kill we asked for, not a failure, so it must be restarted regardless
      // of what `initialized` currently says.
      if (!wasIntentional && (wasHealthy || wasCancelled)) {
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
    // Claude is EXCLUDED: its restore isn't supported yet, so a persisted id
    // would be dead weight in acpSessionIds (never read — claude always spawns
    // fresh). Persist claude here too once restore works.
    // EXPERIMENT 2026-08-03 (uncommitted): claude re-included — a persisted id
    // is what --resume reads on the next spawn. Without it every restart is a
    // fresh session and cancel destroys the agent rather than the turn.
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
    // NO throw on a down runtime. This was the last prompt path that ended a
    // human's message with "ACP runtime not initialized" — thrown across IPC
    // into the composer, scheduling NO restart (every other prompt site did)
    // and dropping the text. The pane then stayed dead until someone restarted
    // it by hand. sendPrompt owns the dead-runtime case now: it gets a restart
    // coming and holds the prompt for it. Reported 2026-08-04, again.
    //
    // This cannot revive a pane the user deliberately Stopped: killTerminal
    // removes the manager from acpRuntimes, so a Stopped agent has no runtime
    // to prompt at all. A dead process still holding a registry slot is an
    // unwanted death by definition.
    this.recordUserPrompt(text);
    // Image blocks ride the same session/prompt after the text block. No
    // client-side format/size validation happens here — kimi's server-side
    // gate (byte-sniff, compress, caption) owns image correctness.
    const prompt: AcpSendContentBlock[] = [{ type: 'text', text }];
    for (const image of images ?? []) {
      prompt.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    }
    // A human prompt that will STEER into a busy turn still influences the
    // live task (good), but the turn may never end — arm the backstop that
    // guarantees the human a dedicated reply turn. Only against a LIVE turn:
    // promptInFlight can be stale-true on a runtime that died mid-turn, and
    // the backstop's job (cancel the turn that owes a reply) is meaningless
    // there — it would only fire a cancel at a corpse.
    if (this.promptInFlight && this.process?.isRunning()) {
      this.armHumanWaitBackstop();
    }
    await this.sendPrompt(prompt, 'human');
  }

  private async systemPrompt(text: string): Promise<void> {
    // Same as prompt(): no throw. Callers only .catch()-and-log, so throwing
    // here silently abandoned the kickoff/nudge with nothing scheduled to
    // bring the runtime back.
    const prompt: AcpSendContentBlock[] = [{ type: 'text', text }];
    await this.sendPrompt(prompt, 'system');
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
   * Returns a tri-state (Jon 2026-08-01): 'delivered' / 'deferred' (parked by
   * design — NOT a failure) / 'failed' (runtime genuinely unreachable), so
   * the renderer can say the true thing in the pane instead of crying
   * "Delivery failed" for a routine defer.
   */
  async injectMail(text: string): Promise<AcpMailInjectResult> {
    if (!this.process?.isRunning() || !this.sessionId) {
      // A restart already coming means this is a defer, not a failure: the
      // resume path offers held mail (see offerDeferredMail's call in
      // restart()). Only a runtime nothing will revive is a real 'failed'.
      if (this.restartTimer || this.restarting || this.cancelExpectingRestart) {
        this.rememberDeferredMail(text);
        console.log(
          `[ACP ${this.options.agentName}] mail deferred (runtime restarting) — will be summarised after the resume ` +
            `— ${this.describeRuntimeState()}`,
        );
        return 'deferred';
      }
      console.warn(
        `[ACP ${this.options.agentName}] injectMail skipped: runtime not initialized — ${this.describeRuntimeState()}`,
      );
      return 'failed';
    }

    const prompt: AcpSendContentBlock[] = [{ type: 'text', text }];
    this.recordUserPrompt(text);
    if (this.promptInFlight) {
      // Jon 2026-08-01: mail NEVER interrupts an active turn. The steer path
      // beheads the in-flight step (StepInterrupted ~1s — measured across
      // three agents simultaneously: agents mailing each other meant every
      // step died, and restarting the sessions did not cure it). Mail is
      // durable in the inbox; defer it. The idle catch-up synthesis
      // re-notifies when the turn completes.
      this.rememberDeferredMail(text);
      console.log(
        `[ACP ${this.options.agentName}] mail deferred (active turn) — no interruption; will be summarised at idle ` +
          `(${this.deferredMailHeaders.length + this.deferredMailOverflow} waiting)`,
      );
      return 'deferred';
    }
    this.executePrompt(prompt);
    return 'delivered';
  }

  /**
   * Resolves true once the prompt was actually dispatched to the runtime,
   * false when it never will be (runtime down, or the queue entry was dropped
   * by dropQueuedPrompts). Callers that only care about delivery events can
   * keep ignoring the result; injectMail depends on it (WO 11462).
   */
  private sendPrompt(prompt: AcpSendContentBlock[], kind: 'human' | 'system'): Promise<boolean> {
    if (!this.process?.isRunning() || !this.sessionId) {
      // Get a restart coming FIRST, then decide the prompt's fate from whether
      // one actually is. A dead runtime is not a reason to throw the message
      // away: hold it exactly like a prompt queued behind a live turn, and the
      // existing restart machinery settles it (drained on a resumed session,
      // dropped visibly on a fresh one, dropped again if the restart budget is
      // gone). This branch used to be terminal for the message.
      console.warn(
        `[ACP ${this.options.agentName}] ${kind} prompt hit a down runtime — ${this.describeRuntimeState()}`,
      );
      this.scheduleRestart('runtime not running when prompt sent');
      if (this.restartTimer || this.restarting || this.cancelExpectingRestart) {
        return this.holdForRestart(prompt, kind);
      }
      // Nothing is coming — the restart budget is exhausted (scheduleRestart
      // has already said so, and settled the rest of the queue). Fail visibly
      // rather than park the message on a runtime that will never return.
      // The state snapshot rides along: this string is what lands in the pane
      // (and used to be ALL anyone got), so it has to name the cause.
      const message = `ACP runtime not initialized [${this.describeRuntimeState()}]`;
      console.error(`[ACP ${this.options.agentName}] ${message}`);
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? '', error: message });
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
      if (this.steerUnsupported) {
        // Learned no-steer runtime: skip the doomed steer (a guaranteed
        // turn.agent_busy round-trip plus adapter stderr spam) and take the
        // queue backstop directly.
        return this.enqueueBehindActiveTurn(prompt, kind);
      }
      return this.steerThrough(prompt, kind);
    }

    this.executePrompt(prompt, undefined, false, kind);
    return Promise.resolve(true);
  }

  /**
   * Park a prompt sent at a runtime that is down but coming back. Identical
   * settlement contract to enqueueBehindActiveTurn — the waiter resolves true
   * when the entry drains after the resume, false if it is dropped — so the
   * renderer's queued indicator (prompt_queued) means the same thing in both
   * cases: "sent, not yet dispatched".
   */
  private holdForRestart(prompt: AcpSendContentBlock[], kind: 'human' | 'system'): Promise<boolean> {
    const sessionId = this.sessionId ?? '';
    console.warn(
      `[ACP ${this.options.agentName}] runtime down — holding ${kind} prompt for the pending restart ` +
        `(depth=${this.promptQueue.length + 1}) — ${this.describeRuntimeState()}`,
    );
    const promise = new Promise<boolean>((resolve) => {
      this.promptQueue.push({ prompt, resolve, kind });
    });
    this.emitAcpEvent({
      sessionUpdate: 'prompt_queued',
      sessionId,
      queueDepth: this.promptQueue.length,
    });
    return promise;
  }

  /**
   * Queue a prompt behind the active turn without attempting a steer — the
   * path taken once the runtime has taught us it busy-rejects mid-turn
   * prompts. Identical settlement to the steer busy-fallback: the waiter
   * resolves when the entry drains (or false on drop), and prompt_queued is
   * the renderer's only queued-indicator signal.
   */
  private enqueueBehindActiveTurn(
    prompt: AcpSendContentBlock[],
    kind: 'human' | 'system',
  ): Promise<boolean> {
    const sessionId = this.sessionId ?? '';
    console.log(`[ACP ${this.options.agentName}] no-steer runtime — queuing ${kind} prompt behind active turn (session=${sessionId})`);
    const promise = new Promise<boolean>((resolve) => {
      this.promptQueue.push({ prompt, resolve, kind });
    });
    this.emitAcpEvent({
      sessionUpdate: 'prompt_queued',
      sessionId,
      queueDepth: this.promptQueue.length,
    });
    return promise;
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
    kind: 'human' | 'system',
    opts?: { queueOnBusy?: boolean },
  ): Promise<boolean> {
    const sessionId = this.sessionId ?? '';
    const preview = prompt.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ').slice(0, 120);
    console.log(`[ACP ${this.options.agentName}] >>> session/prompt (steer into active turn, session=${sessionId}): ${preview}`);
    const entry: { prompt: AcpSendContentBlock[]; resolve: (dispatched: boolean) => void; kind: 'human' | 'system' } = {
      prompt,
      kind,
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
          // The first busy rejection teaches the manager this runtime cannot
          // steer (kimi ACP ≤0.31.x): later prompts queue directly and the
          // human-reply backstop switches to its no-steer shape.
          this.steerUnsupported = true;
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
          this.promptQueue.push({ prompt: entry.prompt, resolve: entry.resolve, kind: entry.kind });
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

  /**
   * Arm the human-reply backstop after a human prompt steered into a busy
   * turn. FIRST unanswered steer per busy episode sets the deadline — later
   * steers deliberately do NOT extend it: a chatty human messaging every few
   * seconds would otherwise push the boundary out forever and the backstop
   * would never fire (observed: 16 rapid human steers, zero cancels). On
   * expiry the turn is cancelled and a front-of-queue nudge drains as a
   * dedicated reply turn. Mail (injectMail) deliberately never arms this —
   * mail is background work, the human is not.
   *
   * The nudge's shape depends on the learned steer capability: on a
   * steer-capable runtime the human's messages are already in the session's
   * context (ending the turn flushes any pending text); on a no-steer runtime
   * they sit in promptQueue, so their text is folded INTO the nudge — see
   * takeQueuedHumanTexts.
   */
  private armHumanWaitBackstop(): void {
    if (this.humanWaitTimer) return;
    // Stage 1 (45s): warn, don't cancel. The agent closes its own turn at a
    // clean boundary — the task list is never shut down when it complies.
    this.humanWaitWarnTimer = setTimeout(() => {
      this.humanWaitWarnTimer = null;
      if (!this.promptInFlight || !this.process?.isRunning()) return;
      if (this.steerUnsupported) {
        // The warning can only reach the agent as a steer, and this runtime
        // busy-rejects steers — skip the doomed request (guaranteed rejection
        // plus adapter stderr spam for zero effect). The grace cancel below
        // still bounds the human's wait.
        return;
      }
      console.warn(
        `[ACP ${this.options.agentName}] human prompt unanswered for ${HUMAN_REPLY_WARN_MS}ms inside a busy turn — sending wrap-up warning steer`,
      );
      void this.steerThrough([{ type: 'text', text: HUMAN_WAIT_WARNING }], 'system', { queueOnBusy: false });
    }, HUMAN_REPLY_WARN_MS);
    // Stage 2 (60s): last resort. Cancel, and the nudge tells the agent it was
    // cut off so it can resume after answering.
    this.humanWaitTimer = setTimeout(() => {
      this.humanWaitTimer = null;
      // Turn ended in the meantime — the natural turn flow owned the reply.
      if (!this.promptInFlight || !this.process?.isRunning() || !this.sessionId) return;
      if (this.replyTurnActive) {
        // The in-flight turn IS the dedicated reply turn carrying the human's
        // folded messages. Cancelling it only beheads the reply the human is
        // waiting for and re-arms the same nudge — the chatty-episode loop
        // (BAPert 2026-08-01: five reply turns cancelled mid-composition in
        // one episode, zero answers delivered). Newer human messages queue
        // and drain after this reply; the 300s idle watchdog owns real wedges.
        console.log(
          `[ACP ${this.options.agentName}] reply turn already in flight — leaving it alone; newer human prompts drain after it`,
        );
        return;
      }
      const sessionId = this.sessionId;
      console.warn(
        `[ACP ${this.options.agentName}] human prompt unanswered for ${HUMAN_REPLY_GRACE_MS}ms inside a busy turn — cancelling so the human gets a dedicated reply turn`,
      );
      this.sendSessionCancel(sessionId);
      // On a no-steer runtime the human's messages never reached the agent —
      // they are waiting in promptQueue. Fold their text into the reply-turn
      // nudge so the reply turn answers what was actually said, and so the
      // backlog does not drain one stale message per turn afterwards.
      const missedTexts = this.takeQueuedHumanTexts();
      this.promptQueue.unshift({
        prompt: [{ type: 'text', text: buildHumanWaitingNudge(missedTexts) }],
        resolve: () => {},
        kind: 'system',
        replyNudge: true,
      });
    }, HUMAN_REPLY_GRACE_MS);
  }

  private clearHumanWaitBackstop(): void {
    if (this.humanWaitWarnTimer) {
      clearTimeout(this.humanWaitWarnTimer);
      this.humanWaitWarnTimer = null;
    }
    if (this.humanWaitTimer) {
      clearTimeout(this.humanWaitTimer);
      this.humanWaitTimer = null;
    }
  }

  /**
   * Remove the text-only human prompts waiting in the queue and return their
   * text in arrival order, settling their waiters as dispatched — the content
   * rides inside the reply-turn nudge instead of a turn of its own.
   * Image-bearing prompts stay queued: an image cannot ride a text nudge, and
   * a late delivery beats a silently dropped attachment.
   */
  private takeQueuedHumanTexts(): string[] {
    const texts: string[] = [];
    const kept: typeof this.promptQueue = [];
    for (const entry of this.promptQueue) {
      if (entry.kind === 'human' && entry.prompt.every((b) => b.type === 'text')) {
        const text = entry.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
        if (text) texts.push(text.length > 1000 ? `${text.slice(0, 1000)}…` : text);
        entry.resolve(true);
      } else {
        kept.push(entry);
      }
    }
    if (kept.length !== this.promptQueue.length) {
      this.promptQueue = kept;
      // Keep the renderer's queued indicator honest about the new depth.
      this.emitAcpEvent({
        sessionUpdate: 'prompt_dequeued',
        sessionId: this.sessionId ?? '',
        queueDepth: this.promptQueue.length,
      });
    }
    return texts;
  }

  private executePrompt(
    prompt: AcpSendContentBlock[],
    resolveDispatched?: (dispatched: boolean) => void,
    isAgentBusyRetry = false,
    kind: 'human' | 'system' = 'system',
  ): void {
    if (!this.process?.isRunning() || !this.sessionId) {
      const message = `ACP runtime not initialized [${this.describeRuntimeState()}]`;
      console.error(`[ACP ${this.options.agentName}] executePrompt(${kind}) on a down runtime: ${message}`);
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? '', error: message });
      this.scheduleRestart('runtime not running when prompt sent');
      resolveDispatched?.(false);
      this.promptInFlight = false;
      this.drainPromptQueue();
      return;
    }

    this.promptInFlight = true;
    if (kind === 'human') {
      // The human's own prompt is becoming the active turn — they are being
      // SERVED, not waiting behind someone else's busy turn. A backstop armed
      // while they sat in the queue must not fire against their answer turn
      // (BAPert 2026-08-01: the 60s grace cancel killed the turn that was
      // mid-answer to the human's question; the nudge turn that followed only
      // carried the later "be precise"). If the human speaks again mid-turn,
      // prompt() re-arms the backstop for the new wait — no re-arm needed here.
      this.clearHumanWaitBackstop();
    }
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
        this.replyTurnActive = false;
        this.clearHumanWaitBackstop();
        if (this.stalledTurnNudgePending) {
          this.stalledTurnNudgePending = false;
          this.cancelGraceTicksLeft = null;
          // The stall honored the cancel: same process, session and context
          // intact — NO restart. Tell the agent its turn was cut and to
          // report + continue (Jon's rule: never let an agent wonder why its
          // turn died), ahead of anything queued.
          this.promptQueue.unshift({
            prompt: [{ type: 'text', text: STALLED_TURN_NUDGE }],
            resolve: () => {},
            kind: 'system',
          });
        }
        this.drainPromptQueue();
      })
      .catch((err) => {
        if (settledRef.current) return;
        settledRef.current = true;
        // Any error settle ends the watchdog ladder episode without the nudge.
        this.cancelGraceTicksLeft = null;
        this.stalledTurnNudgePending = false;
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
            this.promptQueue.unshift({ prompt, resolve: resolveDispatched ?? (() => {}), kind });
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
              this.sendSessionCancel(sessionId);
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
              if (cancelNeeded) this.sendSessionCancel(sessionId);
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
          this.sendSessionCancel(sessionId);
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
    if (next.replyNudge) this.replyTurnActive = true;
    this.executePrompt(next.prompt, next.resolve, true, next.kind);
  }

  private drainPromptQueue(): void {
    if (!this.process?.isRunning() || !this.sessionId) {
      // A restart is genuinely coming: hold the prompts for it. They are still
      // valid work, and the post-restart path already decides their fate —
      // drained on a resumed session, dropped on a fresh one, dropped again if
      // the restart budget runs out. Dropping them HERE threw away the human's
      // message on every Esc and every watchdog kill, because this drain runs
      // before the exit is processed and therefore before restartTimer is set.
      if (this.restartTimer || this.cancelExpectingRestart) {
        console.log(
          `[ACP ${this.options.agentName}] holding ${this.promptQueue.length} queued prompt(s) across the pending restart`,
        );
        return;
      }
      // Nothing is bringing the runtime back — fail them so the user sees
      // feedback rather than an eternal spinner.
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
      if (next.replyNudge) this.replyTurnActive = true;
      this.executePrompt(next.prompt, next.resolve, false, next.kind);
      return;
    }
    // Queue empty = the agent is genuinely idle. This is the ONLY moment mail
    // that deferred mid-turn gets re-offered.
    this.offerDeferredMail();
  }

  /** Remember a deferred notice's header line (from/subject/id) for the idle summary. */
  private rememberDeferredMail(text: string): void {
    const header = (text.split('\n', 1)[0] ?? text).slice(0, 200).trim();
    if (this.deferredMailHeaders.length < this.MAX_DEFERRED_MAIL_LINES) {
      this.deferredMailHeaders.push(header);
    } else {
      this.deferredMailOverflow += 1;
    }
  }

  /**
   * Offer mail that deferred during a live turn, ONCE, as a single summary.
   *
   * WHY THIS IS NOT THE THING THAT WAS DELETED (WO 11473, removed 2026-08-01):
   * that synthesis swept the INBOX and injected one turn per unread, on connect
   * and on boot — unbounded in the backlog, so a busy mailbox put an agent ~50
   * turns in the hole before it finished booting (and burned the kimi budget
   * doing it). This is the opposite on every axis that mattered:
   *
   *   - source: only what deferred in THIS process, held in memory. Never the
   *     inbox, never persisted, gone on restart.
   *   - cost: ONE turn regardless of how many messages — subjects only, no
   *     bodies. The agent triages and fetches what it actually needs.
   *   - trigger: agent-idle (prompt queue empty), never connect/reconnect/boot.
   *   - lifetime: offered once, then forgotten. The inbox remains the record.
   *
   * The defer branch has promised "idle catch-up will deliver" since WO 11622,
   * but the mechanism it pointed at was the one deleted above — the two shared
   * an implementation and only one caller was considered. Every deferral since
   * has been a silent permanent drop with a reassuring log line: measured at
   * 10 of 30 notices (33%) in one standup round, concentrated on the busiest
   * agents, because being mid-turn is the trigger.
   */
  private offerDeferredMail(): void {
    if (!this.deferredMailHeaders.length) return;
    const headers = this.deferredMailHeaders;
    const overflow = this.deferredMailOverflow;
    const total = headers.length + overflow;
    // Clear BEFORE dispatching: the summary is itself a turn, whose completion
    // re-enters drainPromptQueue. Clearing first is what stops it looping.
    this.deferredMailHeaders = [];
    this.deferredMailOverflow = 0;

    const lines = headers.map((h) => `  • ${h}`).join('\n');
    const more = overflow > 0 ? `\n  …and ${overflow} more waiting in your inbox.` : '';
    const text =
      `[ACP Mail] ${total} message(s) arrived while you were mid-turn:\n${lines}${more}\n\n` +
      `These were NOT injected at the time — mail never interrupts a live turn. ` +
      `Read the ones that matter, do not assume you have seen the full thread: ` +
      `curl -s "http://127.0.0.1:3001/v1/mail/messages/<id>" -H "X-ACP-Agent: ${this.options.agentName}"`;

    console.log(`[ACP ${this.options.agentName}] offering ${total} deferred mail notice(s) at idle`);
    this.executePrompt([{ type: 'text', text }], undefined, false, 'system');
  }

  cancel(): void {
    // A deliberate human cancel supersedes any armed watchdog ladder — the
    // resume nudge must not fire after a turn the USER chose to end.
    this.cancelGraceTicksLeft = null;
    this.stalledTurnNudgePending = false;
    const sessionId = this.sessionId;
    // isRunning(), not just a non-null reference: the manager keeps its handle
    // after the child dies, so `this.process &&` was true for a corpse and the
    // wedge branch below could never be reached.
    if (this.process?.isRunning() && sessionId) {
      // On claude this notify IS a process kill (`-p` has no cancel verb), so
      // a restart is coming and the queue must survive it — see drainPromptQueue.
      this.cancelExpectingRestart = true;
      this.sendSessionCancel(sessionId);
    } else if (!this.restartTimer && !this.intentionalKill) {
      // THE WEDGE. A cancel that arrives when the runtime is already down — a
      // second Esc, or one racing the previous exit — finds no process to
      // signal. By then the exit handler's `wasHealthy` guard has already gone
      // false (initialized was cleared by the first exit), so it scheduled no
      // restart either. Nothing is coming: the pane stays dead until a human
      // restarts it, every prompt fails "ACP runtime not initialized", and
      // incoming mail is failed outright rather than deferred.
      // Observed twice on 2026-08-03. A cancel must never be the thing that
      // ends an agent — that is what the Stop button is for.
      console.warn(
        `[ACP ${this.options.agentName}] cancel with no live runtime — scheduling a restart so the pane does not stay dead ` +
          `— ${this.describeRuntimeState()}`,
      );
      this.scheduleRestart('cancel arrived with no live runtime');
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
    // A deliberate kill ends any restart a cancel was expecting, so the held
    // queue must not outlive it — dropQueuedPrompts below settles it unless
    // the caller is restart(), which preserves it on purpose.
    this.cancelExpectingRestart = false;
    this.stopPromptWatchdog();
    this.clearHumanWaitBackstop();
    this.replyTurnActive = false;
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
    this.recordDown(`kill() by the app (preserveQueue=${opts?.preserveQueue === true}, midTurn=${this.promptInFlight})`);
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
      // The restart a cancel was expecting has happened. Cleared HERE and not
      // in markHealthy(), which also runs on every successful turn settle —
      // i.e. immediately before the queue drain, wiping the flag at exactly
      // the moment it is needed.
      this.cancelExpectingRestart = false;
      console.log(`[ACP ${this.options.agentName}] Runtime restarted`);
      if (this.promptQueue.length > 0 || this.pendingSteers.size > 0) {
        if (this.resumedLastStart) {
          // Context survived the restart — queued prompts still make sense,
          // and steered prompts must be re-dispatched: the turn they were
          // steered into died with the old process.
          for (const steer of this.pendingSteers) {
            this.promptQueue.push({ prompt: steer.prompt, resolve: steer.resolve, kind: steer.kind });
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
      // Mail held from before the restart is offered here too, NOT only via
      // drainPromptQueue: the drain above is gated on there being queued
      // prompts, and a watchdog kill calls dropQueuedPrompts() first — so an
      // agent that stalled, died and resumed comes back with an empty queue
      // and nothing would ever trigger the offer. That is exactly the agent
      // that most needs to know what it missed while it was face-down.
      // Only meaningful on a resumed session; a fresh one has no continuity to
      // hand the mail back into (dropQueuedPrompts above makes the same call).
      if (this.resumedLastStart) this.offerDeferredMail();
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
      // The terminal state: nothing will bring this pane back without a human.
      // Log the full snapshot here or the budget-exhaustion is invisible in the
      // logs except as a sudden absence of restarts.
      console.error(`[ACP ${this.options.agentName}] ${message} — ${this.describeRuntimeState()}`);
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

  /**
   * The ONLY way to send session/cancel. Every cancel site must route through
   * here — there are seven (watchdog ladder x2, human-wait backstop,
   * agent-busy probes x3, and the human cancel), and on claude EVERY one of
   * them is a process kill, because `-p` has no cancel verb.
   *
   * Recording the expectation before the notify is the whole point: the prompt
   * queue drains on turn-settle, which happens BEFORE the exit is processed
   * and therefore before restartTimer exists. Without this flag the drain
   * cannot tell "the runtime is gone for good" from "the runtime is coming
   * right back", and discards the human's queued messages either way.
   *
   * Learned the hard way (2026-08-03): the fix was first applied to cancel()
   * alone, and the very next wedge came in through the human-wait backstop —
   * a different site, same kill, none of the protection.
   */
  private sendSessionCancel(sessionId: string | null): void {
    if (!sessionId) return;
    this.cancelExpectingRestart = true;
    this.process?.notify('session/cancel', { sessionId });
  }

  private markHealthy(): void {
    if (this.restartCount > 0) {
      console.log(`[ACP ${this.options.agentName}] runtime healthy; reset restart counter`);
      this.restartCount = 0;
    }
  }

  /**
   * Record why the runtime went down, at the site that took it down. Read back
   * by describeRuntimeState() so the next "runtime not initialized" carries the
   * cause instead of only the symptom.
   */
  private recordDown(reason: string): void {
    this.lastDownReason = { reason, at: Date.now() };
  }

  /**
   * One-line snapshot of everything that decides whether a prompt can be sent
   * right now, and what is (or is not) coming to fix it. Appended to every
   * down-runtime log line and to the error the renderer surfaces.
   *
   * The two halves of the `!process?.isRunning() || !sessionId` guard are
   * DIFFERENT failures — a dead child vs. a live child whose session never
   * established (handshake in flight, resume rejected) — and the old message
   * collapsed them into one indistinguishable string.
   */
  private describeRuntimeState(): string {
    const proc = !this.process ? 'absent' : this.process.isRunning() ? 'running' : 'dead';
    const parts = [
      `process=${proc}`,
      `session=${this.sessionId ?? 'none'}`,
      `initialized=${this.initialized}`,
      `promptInFlight=${this.promptInFlight}`,
      `queue=${this.promptQueue.length}`,
      `steers=${this.pendingSteers.size}`,
      `heldMail=${this.deferredMailHeaders.length + this.deferredMailOverflow}`,
      `restarts=${this.restartCount}/${this.MAX_RESTARTS}`,
      `restartTimer=${this.restartTimer ? 'pending' : 'none'}`,
      `restarting=${this.restarting}`,
      `cancelExpectingRestart=${this.cancelExpectingRestart}`,
      `intentionalKill=${this.intentionalKill}`,
    ];
    if (this.lastDownReason) {
      const ago = Math.round((Date.now() - this.lastDownReason.at) / 100) / 10;
      parts.push(`lastDown="${this.lastDownReason.reason}" ${ago}s ago`);
    } else {
      parts.push('lastDown=never (runtime has not been down in this process)');
    }
    return parts.join(' ');
  }

  /** Same snapshot, for out-of-band inspection (IPC diagnostics, tests). */
  getRuntimeState(): string {
    return this.describeRuntimeState();
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
    this.logStreamDebug(update);
    this.emit('event', payload);
  }

  /**
   * OFF BY DEFAULT. Mirror session updates to stdout for out-of-app observers.
   *
   * Session updates go to the renderer over IPC and never touch stdout, so
   * from a log tail a hung turn and a long tool call are indistinguishable —
   * both are simply silence until the 300s watchdog trips. That silence is
   * exactly when you most want to know what the agent was doing (2026-08-03:
   * two agents stalled 300s on a mail-triggered turn with no way to tell a
   * blocked network probe from real thinking).
   *
   *   ACP_STREAM_DEBUG=1    turn boundaries, tool calls, plans, errors
   *   ACP_STREAM_DEBUG=all  the above plus thought/message chunks (very loud)
   *
   * Never throws: a logging fault must not take down a runtime.
   */
  private logStreamDebug(update: AcpSessionUpdate): void {
    const level = process.env.ACP_STREAM_DEBUG;
    if (!level) return;
    try {
      const kind = update.sessionUpdate;
      if (NOISY_SESSION_UPDATES.has(kind) && level !== 'all') return;
      const u = update as unknown as Record<string, unknown>;
      // tool_call / tool_call_update carry their identity NESTED under
      // `toolCall`, which is precisely the case worth logging — a stall's last
      // event is almost always a tool. Look there first, then top level.
      const tc = (u.toolCall ?? {}) as Record<string, unknown>;
      const toolDetail = tc.title
        ? `${String(tc.title)}${tc.status ? ` [${String(tc.status)}]` : ''}`
        : undefined;
      const detail =
        toolDetail ??
        (u.title as string | undefined) ??
        (u.toolName as string | undefined) ??
        (u.status as string | undefined) ??
        (u.stopReason as string | undefined) ??
        (typeof u.text === 'string' ? u.text : undefined) ??
        (typeof u.content === 'string' ? u.content : undefined) ??
        '';
      const trimmed = String(detail).replace(/\s+/g, ' ').slice(0, 160);
      console.log(
        `[stream ${this.options.agentName}] ${kind}${trimmed ? ` — ${trimmed}` : ''}`,
      );
    } catch {
      // Diagnostics are best-effort by definition.
    }
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
 * How long a busy turn may keep running after a human prompt steered into it
 * before the runtime forces a turn boundary. The steer lets the human's info
 * influence the live task; this backstop bounds how long the agent may stay
 * heads-down before it owes the human a dedicated reply turn (text posts at
 * turn end, so without a boundary the human can wait forever on a
 * mail-storm-driven busy episode).
 */
const HUMAN_REPLY_GRACE_MS = 60_000;

/**
 * Stage 1 of the human-reply backstop: after this long with the human's
 * steered message still unanswered, send a wrap-up warning INTO the live turn
 * (a steer, not a cancel). The agent ends its own turn at a clean boundary —
 * the task list is never shut down when it complies.
 */
const HUMAN_REPLY_WARN_MS = 45_000;

const HUMAN_WAIT_WARNING =
  '[ACP] The human sent you a message during this turn and is still waiting for a direct reply. ' +
  'Wrap up your current step and answer them in text NOW. If this turn is still running in ~15 seconds, ' +
  'the platform will end it so they get a reply turn — closing it cleanly yourself keeps your task intact.';

/**
 * Front-of-queue nudge dispatched after the human-reply backstop cancels a
 * busy turn. This opens the dedicated reply turn, TELLS the agent it was cut
 * off (Jon's rule: never let an agent wonder why its turn died), and pins the
 * resume.
 */
const HUMAN_WAITING_NUDGE =
  '[ACP] The platform ended your previous turn MID-TASK so the human could get a direct reply — your work is intact in your context above, nothing was lost. ' +
  'Answer the human’s message now — briefly, in text, no tools — then resume the task from where you were cut off.';

/**
 * Watchdog ladder (cancel-first, kill-last + throttle-aware grace).
 */
/** Ticks (× the 15s watchdog interval) a cancelled stall gets to settle before the kill+restart escalates. */
const WATCHDOG_CANCEL_GRACE_TICKS = 2;
/** How long stderr throttle evidence (429/quota/backoff) stays fresh enough to extend grace. */
const THROTTLE_EVIDENCE_FRESH_MS = 10 * 60_000;
/**
 * Consecutive full-budget throttle extensions before the ladder treats the
 * stall as a wedge anyway (bounds a misclassified wait at ~25 min).
 */
const MAX_THROTTLE_EXTENSIONS = 4;
/** Provider-throttle signatures in adapter stderr. */
const THROTTLE_STDERR_PATTERN = /\b429\b|rate.?limit|too many requests|quota|balance|overload|retry.?after/i;

/**
 * Nudge unshifted after a stalled turn HONORS the watchdog's session/cancel:
 * the runtime proved itself alive, so it keeps its process, session and
 * context — no restart. It is told why its turn died and to report +
 * continue (same rule as HUMAN_WAITING_NUDGE).
 */
const STALLED_TURN_NUDGE =
  '[ACP] Your previous turn produced no output for over 5 minutes, so the platform cancelled it — your process, session and context are intact, nothing was restarted. ' +
  'Briefly tell the human where things stand, then continue your work.';

/**
 * Build the reply-turn nudge. Steer-capable runtime: the human's steered
 * messages are already in the session's context, the plain nudge suffices.
 * No-steer runtime (kimi ACP ≤0.31.x): the messages sat in the manager's
 * queue, so their text must ride inside the nudge — otherwise the agent is
 * told to answer a message it never received.
 */
function buildHumanWaitingNudge(missedTexts: string[]): string {
  if (missedTexts.length === 0) return HUMAN_WAITING_NUDGE;
  const single = missedTexts.length === 1;
  const list = missedTexts.map((t, i) => `${i + 1}. "${t}"`).join('\n');
  return (
    '[ACP] The platform ended your previous turn MID-TASK so the human could get a direct reply — your work is intact in your context above, nothing was lost. ' +
    `While you were busy the human sent ${single ? 'this message' : `these ${missedTexts.length} messages`}; ` +
    `the runtime could not deliver ${single ? 'it' : 'them'} mid-turn, so here ${single ? 'it is' : 'they are'}:\n` +
    `${list}\n` +
    'Answer the human now — briefly, in text, no tools — then resume the task from where you were cut off.'
  );
}

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
    /cannot launch a new turn while another turn/i.test(message) ||
    // ClaudeStreamJsonProcess's single-flight rejection. Same CONDITION as
    // kimi's turn.agent_busy — a prompt arrived while a turn was live — but a
    // third phrasing, so it fell through to the hard-failure branch: the human
    // steer was dropped with "[Send failed] Claude turn already in flight"
    // instead of being queued behind the active turn and drained after it.
    // Every busy phrasing on every adapter must land here, or the runtime that
    // spoke it silently loses the queue-and-drain path (Jon 2026-08-03: agents
    // unreachable mid-turn ruined a working session).
    /claude turn already in flight/i.test(message)
  );
}
