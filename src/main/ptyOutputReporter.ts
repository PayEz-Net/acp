/**
 * PTY output reporter.
 *
 * Taps raw node-pty output from acp-desktop and forwards it to the PayEzVibe
 * API (VIBE_API_URL), which authenticates the user and forwards to the internal
 * cache service, which re-emits it as `agent-output` SSE events that the
 * renderer consumes for the unified agent-overview UI.
 *
 * ⚠️ This header used to state that the cache service "normalizes the stream
 * (strip ANSI, scrub secrets)". ANSI stripping is DISPROVEN — raw CSI sequences
 * are at rest in the store, observed via `/v1/terminal/replay` on 2026-07-29.
 * Secret scrubbing is therefore UNVERIFIED, not disproven: it is the untested
 * half of a sentence whose other half was false. Do not rely on either. Tracked
 * as card #114841; treat anything written to this path as stored verbatim until
 * that canary test says otherwise.
 *
 * Batching: PTY output is high-frequency and byte-granular, so we coalesce
 * per-terminal chunks and flush on a short timer or when the buffer grows.
 * This keeps the HTTP overhead negligible without adding perceptible latency.
 *
 * Idempotency: each logical flush generates an opaque idempotency key. Retries
 * reuse the same key so transient failures do not create duplicate rows in the
 * backend cache.
 *
 * Drop accounting: output that is never delivered is recorded per terminal and
 * logged at the point of loss, with the cause (`no-token` / `network` /
 * `server-error` / `rejected` / `session-pending` / `cancelled`) and the offset
 * from that terminal's first byte. Keep this list in sync with `DropCause` —
 * an enumeration in prose that drifts from the union below is the same defect
 * class this module exists to surface.
 * `getDropStats()` exposes the same data for external instrumentation. Loss is
 * expected under a down backend; loss that cannot be attributed to a terminal
 * and a cause is what makes a replay capture unauditable.
 */

import { getAccessToken } from './auth';
import { VIBE_API_URL } from './env';
import { configureSpill, drainSpill, spillOutput, spillStats, isSpillConfigured } from './outputSpill';

interface PendingOutput {
  agentName: string;
  terminalId: string;
  provider?: string;
  sessionToken?: string;
  chunks: string[];
  timer: NodeJS.Timeout | null;
}

interface CloudOutputPayload {
  agentName: string;
  terminalId: string;
  data: string;
  provider?: string;
  sessionToken?: string;
}

const FLUSH_INTERVAL_MS = 150;
const MAX_BUFFER_BYTES = 8192;
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

const pending = new Map<string, PendingOutput>();

/**
 * Why a report was abandoned. `no-token` is broken out from `network` on
 * purpose: both are status-less and therefore identical to `isRetryable`, but
 * only one of them means "auth was not ready yet". Collapsing them is what made
 * boot-window loss unattributable.
 */
export type DropCause =
  | 'no-token'
  | 'network'
  | 'server-error'
  | 'rejected'
  /** The cloud had no active agent session yet. Transient by construction — the
   *  session is created moments later — so this is retried, not dropped. It gets
   *  its own cause so an exhausted chain is distinguishable from a genuinely
   *  malformed request. */
  | 'session-pending'
  | 'cancelled';

interface RetryItem {
  payload: CloudOutputPayload;
  idempotencyKey: string;
  attempts: number;
  /** Cause of the most recent failure, so an exhausted retry chain reports what
   *  actually killed it rather than a generic "gave up". */
  lastCause: DropCause;
  timer: NodeJS.Timeout | null;
}

const retryQueue: RetryItem[] = [];

/**
 * Per-terminal drop accounting, surfaced AT THE POINT OF LOSS.
 *
 * The previous implementation kept two global counters and logged them only
 * when a new drop arrived more than 30s after the last log. That had three
 * defects: drops carried no terminal/agent attribution, the boot window was
 * invisible until 30s in, and — because the flush was triggered by an incoming
 * drop rather than by elapsed time — a burst that stopped (API recovers after
 * boot) was never logged at all.
 *
 * Each drop now logs immediately with agent, terminal, byte count, cause, retry
 * attempts, and offset from that terminal's first output. Past
 * DETAIL_LOG_LIMIT the terminal falls back to a rollup so a down backend still
 * cannot flood the console — but the rollup is timer-driven, so the final
 * window always reports.
 */
export interface TerminalDropStats {
  agentName: string;
  terminalId: string;
  drops: number;
  bytes: number;
  byCause: Partial<Record<DropCause, number>>;
  firstDropAt: number;
  lastDropAt: number;
  /** Offset from the terminal's first output to its first drop, in ms. The
   *  boot-window signal: a small value means output was lost before the
   *  reporter could ever succeed. */
  firstDropOffsetMs: number | null;
  detailLogged: number;
  reportedDrops: number;
  reportedBytes: number;
  rollupTimer: NodeJS.Timeout | null;
}

/** Detailed lines per terminal before falling back to rollups. Sized to cover a
 *  boot window at full detail — that is the window under investigation. */
const DETAIL_LOG_LIMIT = 25;
const ROLLUP_INTERVAL_MS = 30_000;

const dropStats = new Map<string, TerminalDropStats>();
/** First observed output per terminal, so drops can be expressed as an offset
 *  into that terminal's life rather than as a wall-clock timestamp. */
const firstOutputAt = new Map<string, number>();

function makeKey(terminalId: string): string {
  return terminalId;
}

function getOrCreateStats(terminalId: string, agentName: string): TerminalDropStats {
  let stats = dropStats.get(terminalId);
  if (!stats) {
    stats = {
      agentName,
      terminalId,
      drops: 0,
      bytes: 0,
      byCause: {},
      firstDropAt: 0,
      lastDropAt: 0,
      firstDropOffsetMs: null,
      detailLogged: 0,
      reportedDrops: 0,
      reportedBytes: 0,
      rollupTimer: null,
    };
    dropStats.set(terminalId, stats);
  }
  return stats;
}

function formatCauses(byCause: Partial<Record<DropCause, number>>): string {
  const parts = Object.entries(byCause).map(([c, n]) => `${c}=${n}`);
  return parts.length > 0 ? parts.join(',') : 'none';
}

/** Emit whatever this terminal has accumulated but not yet reported. Safe to
 *  call repeatedly; a no-op when everything is already on the record. */
function logRollup(stats: TerminalDropStats): void {
  if (stats.rollupTimer) {
    clearTimeout(stats.rollupTimer);
    stats.rollupTimer = null;
  }
  const newDrops = stats.drops - stats.reportedDrops;
  if (newDrops <= 0) return;
  const newBytes = stats.bytes - stats.reportedBytes;
  console.warn(
    `[PtyOutput] DROP rollup agent=${stats.agentName} terminal=${stats.terminalId} ` +
    `+${newDrops} drop(s) (+${newBytes} bytes) causes=${formatCauses(stats.byCause)} ` +
    `— terminal total ${stats.drops} drop(s) / ${stats.bytes} bytes`,
  );
  stats.reportedDrops = stats.drops;
  stats.reportedBytes = stats.bytes;
}

function scheduleRollup(stats: TerminalDropStats): void {
  if (stats.rollupTimer) clearTimeout(stats.rollupTimer);
  stats.rollupTimer = setTimeout(() => {
    stats.rollupTimer = null;
    logRollup(stats);
  }, ROLLUP_INTERVAL_MS);
  // Never hold the event loop open just to report drops.
  stats.rollupTimer.unref?.();
}

function recordDrop(
  payload: CloudOutputPayload,
  cause: DropCause,
  attempts: number,
  exhausted: boolean,
): void {
  const bytes = Buffer.byteLength(payload.data);
  const now = Date.now();
  const stats = getOrCreateStats(payload.terminalId, payload.agentName);

  stats.drops++;
  stats.bytes += bytes;
  stats.byCause[cause] = (stats.byCause[cause] ?? 0) + 1;
  stats.lastDropAt = now;
  if (stats.firstDropAt === 0) {
    stats.firstDropAt = now;
    const seen = firstOutputAt.get(payload.terminalId);
    stats.firstDropOffsetMs = seen === undefined ? null : now - seen;
  }

  if (stats.detailLogged < DETAIL_LOG_LIMIT) {
    stats.detailLogged++;
    const seen = firstOutputAt.get(payload.terminalId);
    const offset = seen === undefined ? 'unknown' : `${((now - seen) / 1000).toFixed(1)}s`;
    console.warn(
      `[PtyOutput] DROP agent=${payload.agentName} terminal=${payload.terminalId} ` +
      `bytes=${bytes} cause=${cause} attempts=${attempts} exhausted=${exhausted} t+${offset} ` +
      `— terminal total ${stats.drops} drop(s) / ${stats.bytes} bytes`,
    );
    stats.reportedDrops = stats.drops;
    stats.reportedBytes = stats.bytes;
    if (stats.detailLogged === DETAIL_LOG_LIMIT) {
      console.warn(
        `[PtyOutput] agent=${payload.agentName} terminal=${payload.terminalId} hit ` +
        `${DETAIL_LOG_LIMIT} detailed drop lines — further drops roll up every ${ROLLUP_INTERVAL_MS / 1000}s`,
      );
    }
    return;
  }

  // Timer-driven, debounced on the last drop, so a burst that stops still
  // reports its tail. That is the case the old incoming-drop-triggered counter
  // could never emit.
  scheduleRollup(stats);
}

/** Snapshot of per-terminal drop accounting for external instrumentation. */
export function getDropStats(): TerminalDropStats[] {
  return Array.from(dropStats.values()).map((s) => ({ ...s, byCause: { ...s.byCause } }));
}

/** Force any unreported drops for a terminal onto the record. Call before
 *  teardown so the last window is never swallowed. */
export function flushDropStats(terminalId?: string): void {
  if (terminalId) {
    const stats = dropStats.get(terminalId);
    if (stats) logRollup(stats);
    return;
  }
  for (const stats of dropStats.values()) logRollup(stats);
}

function makeIdempotencyKey(): string {
  return `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Carries the HTTP status AND the backend's error code, because status alone is
 * not enough to decide retryability.
 *
 * Both of these are 400:
 *   AGENT_SESSION_NOT_FOUND  — transient; the agent session is created seconds
 *                              later and the identical body then succeeds.
 *   (model validation)       — permanent; the body is malformed and always will be.
 *
 * Treating them alike is what turned recoverable boot-window output into silent
 * permanent loss. The code is the discriminator.
 */
class AgentOutputPostError extends Error {
  readonly status: number;
  /** Backend `error.code`, when the response carried a parseable one. */
  readonly code: string | null;

  constructor(status: number, statusText: string, code: string | null, detail?: string) {
    super(
      `vibe-api POST /v1/agent-output failed: ${status} ${statusText}` +
      (code ? ` (${code})` : '') +
      (detail ? ` — ${detail}` : ''),
    );
    this.name = 'AgentOutputPostError';
    this.status = status;
    this.code = code;
  }
}

/** Backend codes that are transient despite arriving as a 4xx. */
const RETRYABLE_ERROR_CODES = new Set(['AGENT_SESSION_NOT_FOUND']);

/**
 * Pull `error.code` out of a failed response without ever throwing.
 *
 * Reading the body is the only way to tell a transient 400 from a permanent one,
 * and a diagnosis we cannot make is a drop we cannot justify. A body that is
 * empty, truncated, or not JSON simply yields a null code — the caller then falls
 * back to status-only handling, which is the pre-existing behavior.
 */
async function readErrorCode(res: Response): Promise<{ code: string | null; detail: string | null }> {
  try {
    const text = await res.text();
    if (!text) return { code: null, detail: null };
    try {
      const parsed = JSON.parse(text);
      const code = typeof parsed?.error?.code === 'string' ? parsed.error.code : null;
      return { code, detail: null };
    } catch {
      // Not JSON — ASP.NET model-validation failures arrive as ProblemDetails or
      // plain text. Report only the SHAPE, never the content: this string is
      // console-logged from the drop path, which does not pass through the cache
      // service's secret scrubbing that this module's header advertises. An
      // arbitrary upstream body is exactly the thing not to echo, and #114841 is
      // open precisely because that scrubbing is unverified. The code is the only
      // field any decision here depends on; the body was never load-bearing.
      return { code: null, detail: `unparseable body, ${Buffer.byteLength(text)} bytes` };
    }
  } catch {
    return { code: null, detail: null };
  }
}

/** No bearer available at post time. Status-less, so it stays retryable exactly
 *  as before — this type exists purely so the drop record can name auth as the
 *  cause instead of burying it under "network". */
class AgentOutputAuthError extends Error {
  constructor() {
    super('No authenticated user token available');
    this.name = 'AgentOutputAuthError';
  }
}

/**
 * Name the failure precisely enough to act on it. `server-error` and `rejected`
 * are split because they lead to opposite conclusions: a 5xx means the backend
 * was unavailable and the content is recoverable by fixing the deploy, while a
 * 4xx means the request itself is wrong and will fail identically forever.
 */
function classifyDrop(err: unknown): DropCause {
  if (err instanceof AgentOutputAuthError) return 'no-token';
  const status = (err as AgentOutputPostError)?.status;
  if (typeof status !== 'number') return 'network';
  if (status >= 500) return 'server-error';
  const code = (err as AgentOutputPostError)?.code;
  if (code && RETRYABLE_ERROR_CODES.has(code)) return 'session-pending';
  return 'rejected';
}

/**
 * Is this failure worth retrying with the same body?
 *
 * Status-less failures (network, abort, no token) retry. 5xx retries. 408 and 429
 * are the two 4xx *statuses* that describe a transient condition, so they retry.
 *
 * Everything else 4xx is permanent — with one measured exception. A 400 carrying
 * `AGENT_SESSION_NOT_FOUND` is transient: PTY output flushes ~150ms after spawn
 * while `startAgentSession` takes 10-15s, so the cloud legitimately has no session
 * yet and the identical body succeeds once it does.
 *
 * This was measured, not theorised. On the 2026-07-29 boot, all 24 `rejected`
 * drops fell strictly before their terminal's `[AgentSession] started` line and
 * zero fell after. Prior to status-based retry rules these recovered on the
 * 1/2/4/8/16s ladder; making all non-408/429 4xx permanent converted recoverable
 * boot-window output into silent loss. Hence the code check rather than a status
 * check — `AGENT_SESSION_NOT_FOUND` and a malformed-body 400 are the same status
 * and opposite verdicts.
 */
function isRetryable(err: unknown): boolean {
  const status = (err as AgentOutputPostError)?.status;
  if (typeof status !== 'number') return true;
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  const code = (err as AgentOutputPostError)?.code;
  return code != null && RETRYABLE_ERROR_CODES.has(code);
}

/**
 * POST raw PTY output to the PayEzVibe API.
 *
 * Throws on any non-2xx response, carrying the status so the caller can decide
 * between a retry (transient) and a drop (rejected request). PTY output must
 * never crash the desktop, so callers catch rather than surfacing the error.
 */
async function postAgentOutput(payload: CloudOutputPayload, idempotencyKey: string): Promise<void> {
  const token = await getAccessToken();
  if (!token) {
    throw new AgentOutputAuthError();
  }

  const url = `${VIBE_API_URL}/v1/agent-output`;
  const body = JSON.stringify({
    agentName: payload.agentName,
    terminalId: payload.terminalId,
    data: payload.data,
    provider: payload.provider,
    sessionToken: payload.sessionToken,
    idempotencyKey,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body,
  });

  if (!res.ok) {
    const { code, detail } = await readErrorCode(res);
    throw new AgentOutputPostError(res.status, res.statusText, code, detail ?? undefined);
  }
}

function scheduleRetry(
  payload: CloudOutputPayload,
  idempotencyKey: string,
  attempts: number,
  lastCause: DropCause,
): void {
  if (attempts >= MAX_RETRIES) {
    // Exhausting in-memory retries is NOT the end of the line any more. Hand
    // the payload to the disk queue; only a queue that refuses it is a real
    // drop. See outputSpill.ts for why (2.26 MB destroyed by one outage).
    void spillOrDrop(payload, idempotencyKey, lastCause, attempts);
    return;
  }
  const delay = Math.min(RETRY_BASE_MS * Math.pow(2, attempts), RETRY_MAX_MS);
  const item: RetryItem = { payload, idempotencyKey, attempts, lastCause, timer: null };
  retryQueue.push(item);
  item.timer = setTimeout(() => { void processRetry(item); }, delay);
}

/**
 * Last stop before loss: persist the payload, or record a genuine drop.
 *
 * A spilled payload is deliberately NOT counted as a drop — it still exists and
 * will be sent when the backend returns. Counting it would make the drop stats
 * lie in the safe direction, which is still lying. An EVICTED payload IS a drop:
 * the queue was full and something older was destroyed to make room.
 */
async function spillOrDrop(
  payload: CloudOutputPayload,
  idempotencyKey: string,
  cause: DropCause,
  attempts: number,
): Promise<void> {
  if (!isSpillConfigured()) {
    recordDrop(payload, cause, attempts, true);
    return;
  }
  // 184947: persist WHY this exhausted its retries, so the spill file is a
  // real failure record instead of destroying the one thing it was in a
  // position to keep. Previously `cause`/`attempts` were in hand right here
  // and thrown away — the only place either survived was a console.warn.
  //
  // 184984: never write the sessionToken to disk. It is re-resolved live at
  // drain time (getSessionTokenForTerminal) instead of being frozen at
  // whatever it was when this payload first failed — a spilled entry can sit
  // for days, by which point a captured token is exactly as likely to be
  // dead as fresh, and a dead credential written to disk in plaintext buys
  // nothing but retention risk.
  const { sessionToken: _redactedForSpill, ...redactedPayload } = payload;
  const { result, evictedBytes } = await spillOutput(
    redactedPayload,
    idempotencyKey,
    undefined,
    cause,
    attempts,
  );
  if (result === 'unavailable') {
    console.warn(
      `[PtyOutput] SPILL UNAVAILABLE for ${payload.agentName} — falling back to drop`,
    );
    recordDrop(payload, cause, attempts, true);
    return;
  }
  if (result === 'evicted') {
    // Loud on purpose: the queue is full, so we are now destroying the oldest
    // output to keep accepting new. Silence here would read as "all retained".
    console.warn(
      `[PtyOutput] SPILL FULL — evicted ${evictedBytes} bytes of older output ` +
        `to queue ${payload.agentName}. Backend has been unreachable long enough ` +
        `to overflow the on-disk queue.`,
    );
    recordDrop(payload, cause, attempts, true);
    return;
  }
  spilledCount++;
  spilledBytes += Buffer.byteLength(payload.data);
}

let spilledCount = 0;
let spilledBytes = 0;
let drainTimer: NodeJS.Timeout | null = null;

/** Resolves a LIVE sessionToken for a terminal at drain time (184984).
 *  Deliberately a settable hook rather than a static import of pty.ts —
 *  pty.ts already imports THIS module, so a static import back would be
 *  circular. Wired once from index.ts, which imports both. Unwired = drained
 *  payloads carry no sessionToken (already optional server-side) rather than
 *  a stale one from whenever the payload first failed. */
let resolveLiveSessionToken: ((terminalId: string) => string | undefined) | null = null;

export function setLiveSessionTokenResolver(fn: (terminalId: string) => string | undefined): void {
  resolveLiveSessionToken = fn;
}

/**
 * Enable the on-disk queue and start draining it.
 *
 * Call once at main-process startup with `app.getPath('userData')`. Draining
 * starts immediately so output spilled by a PREVIOUS run — one that was killed
 * mid-outage — is recovered rather than orphaned on disk.
 */
export function initOutputSpill(userDataDir: string, drainIntervalMs = 15_000): void {
  configureSpill(`${userDataDir}/agent-output-spill`);
  if (drainTimer) clearInterval(drainTimer);
  drainTimer = setInterval(() => { void runDrain(); }, drainIntervalMs);
  if (typeof drainTimer.unref === 'function') drainTimer.unref();
  void runDrain();
}

let draining = false;

async function runDrain(): Promise<void> {
  if (draining) return; // a slow drain must not overlap itself
  draining = true;
  try {
    const res = await drainSpill<CloudOutputPayload>(
      (payload, key) => {
        // 184984: re-attach a FRESH token rather than whatever (if anything —
        // spillOrDrop redacts it) survived from when this payload first
        // failed. undefined when the terminal is gone or never wired, which
        // is already a supported shape (sessionToken is optional).
        const sessionToken = resolveLiveSessionToken?.(payload.terminalId);
        return postAgentOutput({ ...payload, sessionToken }, key);
      },
      {
        // 140734/184947: classify with the SAME retryability rule already
        // used for in-memory retry, so "backend is down" (break, no count,
        // never dead-lettered) and "this entry is rejected" (skip, count,
        // eventually dead-lettered) cannot be confused with each other.
        classify: (err) => (isRetryable(err) ? 'retryable' : 'terminal'),
      },
    );
    if (res.sent > 0) {
      console.log(
        `[PtyOutput] Recovered ${res.sent} spilled payload(s) from disk; ` +
          `${res.remaining} still queued`,
      );
    }
    if (res.deadLettered > 0) {
      // Loud on purpose, same reasoning as the eviction warning above: a
      // dead-lettered entry will NEVER reach the record through this path,
      // and silence here would look identical to "everything drained clean".
      console.warn(
        `[PtyOutput] DEAD-LETTERED ${res.deadLettered} spilled payload(s) — ` +
          `proven undeliverable across repeated drain attempts (140734). ` +
          `Moved to agent-output-spill/dead-letter, not deleted.`,
      );
    }
  } catch {
    /* next tick retries */
  } finally {
    draining = false;
  }
}

/** Spill/queue counters for status reporting. */
export async function getSpillStats(): Promise<{
  spilledCount: number;
  spilledBytes: number;
  queuedEntries: number;
  queuedBytes: number;
}> {
  const s = await spillStats();
  return {
    spilledCount,
    spilledBytes,
    queuedEntries: s.entries,
    queuedBytes: s.bytes,
  };
}

async function processRetry(item: RetryItem): Promise<void> {
  const idx = retryQueue.indexOf(item);
  if (idx >= 0) retryQueue.splice(idx, 1);
  try {
    await postAgentOutput(item.payload, item.idempotencyKey);
  } catch (err: any) {
    const cause = classifyDrop(err);
    if (!isRetryable(err)) {
      console.warn(`[PtyOutput] Retry abandoned for ${item.payload.agentName} — request rejected:`, err.message);
      recordDrop(item.payload, cause, item.attempts, false);
      return;
    }
    console.warn(`[PtyOutput] Retry failed for ${item.payload.agentName} (cause=${cause}, attempt ${item.attempts + 1}/${MAX_RETRIES}):`, err.message);
    scheduleRetry(item.payload, item.idempotencyKey, item.attempts + 1, cause);
  }
}

async function flushEntry(key: string): Promise<void> {
  const entry = pending.get(key);
  if (!entry || entry.chunks.length === 0) return;

  const data = entry.chunks.join('');
  entry.chunks.length = 0;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  if (!data) return;

  // A chunk with no non-whitespace character persists NOTHING, so posting it is
  // a round trip that cannot produce a row. vsql-cache's OutputNormalizer
  // (Services/OutputNormalizer.cs:27-34) splits into lines, trims each, and
  // `continue`s on IsNullOrWhiteSpace — an all-whitespace chunk yields an empty
  // result. Skipping here is therefore EXACTLY equivalent in stored output, and
  // saves one HTTP request per flush per agent, continuously, across the team.
  //
  // This is not a drop and is deliberately not counted as one: nothing is lost
  // that the backend would otherwise have kept. It is also not the same thing as
  // the server's `[Required(AllowEmptyStrings = true)]` relaxation — that fixes
  // the wrong STATUS (whitespace is not a client error); this removes the
  // pointless CALL. Both are correct, for different reasons.
  //
  // NOTE: ANSI escapes are not whitespace, so TUI repaint frames still post.
  // Narrowing that is the OutputNormalizer work (#114841), not this guard's job.
  if (!data.trim()) return;

  const payload: CloudOutputPayload = {
    agentName: entry.agentName,
    terminalId: entry.terminalId,
    data,
    provider: entry.provider,
    sessionToken: entry.sessionToken,
  };
  const idempotencyKey = makeIdempotencyKey();

  try {
    await postAgentOutput(payload, idempotencyKey);
  } catch (err: any) {
    const cause = classifyDrop(err);
    console.warn(`[PtyOutput] PayEzVibe API post failed for ${entry.agentName} (cause=${cause}):`, err.message);
    if (!isRetryable(err)) {
      recordDrop(payload, cause, 0, false);
      return;
    }
    scheduleRetry(payload, idempotencyKey, 0, cause);
  }
}

export function reportPtyOutput(
  agentName: string,
  terminalId: string,
  data: string,
  provider?: string,
  _projectId?: string,
  _sessionId?: string,
  sessionToken?: string,
): void {
  if (!data) return;

  const key = makeKey(terminalId);
  // Baseline for drop offsets. Recorded on the terminal's first byte, not on
  // entry creation, so `t+` survives the pending entry being cleared or dropped.
  if (!firstOutputAt.has(key)) firstOutputAt.set(key, Date.now());

  let entry = pending.get(key);
  if (!entry) {
    entry = {
      agentName,
      terminalId,
      provider,
      sessionToken,
      chunks: [],
      timer: null,
    };
    pending.set(key, entry);
  }

  entry.chunks.push(data);

  const buffered = entry.chunks.reduce((sum, c) => sum + c.length, 0);
  if (buffered >= MAX_BUFFER_BYTES) {
    void flushEntry(key);
    return;
  }

  if (!entry.timer) {
    entry.timer = setTimeout(() => { void flushEntry(key); }, FLUSH_INTERVAL_MS);
  }
}

/** Flush any pending output for a terminal. Call on PTY exit. */
export function flushPtyOutput(terminalId: string): void {
  void flushEntry(makeKey(terminalId));
}

/**
 * Drop pending output without sending. Call on terminal kill/reset.
 *
 * This is intentional discard, not failure — but it is still content that never
 * reaches the replay, so it is accounted as `cancelled` rather than vanishing
 * silently. Buffered chunks and queued retries were both previously discarded
 * with zero trace, which reads as "nothing was lost" in a capture audit.
 */
export function dropPtyOutput(terminalId: string): void {
  const key = makeKey(terminalId);
  const entry = pending.get(key);
  if (entry?.timer) clearTimeout(entry.timer);

  let cancelledBytes = 0;
  let cancelledItems = 0;
  const agentName = entry?.agentName ?? dropStats.get(terminalId)?.agentName ?? 'unknown';

  if (entry && entry.chunks.length > 0) {
    cancelledBytes += Buffer.byteLength(entry.chunks.join(''));
    cancelledItems++;
  }
  pending.delete(key);

  // Cancel any queued retries for this terminal.
  for (let i = retryQueue.length - 1; i >= 0; i--) {
    const item = retryQueue[i];
    if (item.payload.terminalId === terminalId) {
      if (item.timer) clearTimeout(item.timer);
      cancelledBytes += Buffer.byteLength(item.payload.data);
      cancelledItems++;
      retryQueue.splice(i, 1);
    }
  }

  if (cancelledItems > 0) {
    const stats = getOrCreateStats(terminalId, agentName);
    stats.drops += cancelledItems;
    stats.bytes += cancelledBytes;
    stats.byCause.cancelled = (stats.byCause.cancelled ?? 0) + cancelledItems;
    stats.lastDropAt = Date.now();
    stats.reportedDrops = stats.drops;
    stats.reportedBytes = stats.bytes;
    console.warn(
      `[PtyOutput] DROP agent=${agentName} terminal=${terminalId} ` +
      `bytes=${cancelledBytes} cause=cancelled items=${cancelledItems} ` +
      `— terminal total ${stats.drops} drop(s) / ${stats.bytes} bytes`,
    );
  }

  // Anything still unreported for this terminal goes on the record now; the
  // terminal is going away and nothing will trigger a later rollup.
  flushDropStats(terminalId);
  firstOutputAt.delete(key);
}
