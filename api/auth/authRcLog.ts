/**
 * [AuthRC] — Auth Refresh Cycle structured observability (WO-1 Deliverable D).
 *
 * One stable, greppable `[AuthRC]` prefix per event. Backs both the captured
 * main log AND a queryable ring-buffer surface (sidecar diag endpoint) so we
 * never have to "relaunch and hope it's not stale".
 *
 * Pure module: no express, no fetch, no token values. Everything here is
 * redacted-by-construction (presence/shape only) and unit-testable in
 * isolation. tokenManager writes; authDiag route reads.
 *
 * Repeat-aggregation (spec §5.5): an identical failing OUTCOME (same IDP
 * code) does NOT emit 300 lines — it collapses into a single rolling
 * counter ("INVALID_REFRESH_TOKEN x47 in 50s") flushed on code-change,
 * terminal-dead, or buffer read. Keeps the terminal sequence < 10 lines
 * (acceptance §6.1).
 */

export type AuthRcPhase =
  | 'attempt'        // a refresh was initiated (trigger + cid)
  | 'dedup'          // single-flight: awaiting an in-flight refresh
  | 'token-state'    // redacted snapshot (exp, presence/shape only)
  | 'outbound'       // the actual IDP request line + status (layer-2 closure)
  | 'outcome'        // refreshed | failed | terminal-dead | short-circuited
  | 'short-circuit'  // session already terminal — zero IDP call
  | 'reset';         // terminal flag cleared (fresh login / external-session)

export interface AuthRcEntry {
  ts: string;
  phase: AuthRcPhase;
  cid?: string;
  trigger?: string;
  detail: Record<string, unknown>;
}

const RING_MAX = 200;
const ring: AuthRcEntry[] = [];

// Rolling aggregation of identical repeated failures.
let aggCode: string | null = null;
let aggCount = 0;
let aggFirstMs = 0;
let aggLastTrigger: string | undefined;

function pushRing(entry: AuthRcEntry): void {
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
}

function fmt(e: AuthRcEntry): string {
  const head = `${e.ts} ${e.phase}${e.cid ? ` cid=${e.cid}` : ''}${e.trigger ? ` trig=${e.trigger}` : ''}`;
  let body = '';
  try {
    body = JSON.stringify(e.detail);
  } catch {
    body = '{unserializable}';
  }
  return `[AuthRC] ${head} ${body}`;
}

/** Flush the rolling identical-failure aggregate as one summary entry/line. */
function flushAggregate(reason: 'code-change' | 'terminal' | 'read'): void {
  if (aggCount <= 0 || aggCode == null) return;
  const windowSec = Math.round((Date.now() - aggFirstMs) / 1000);
  const halted = reason === 'terminal';
  const entry: AuthRcEntry = {
    ts: new Date().toISOString(),
    phase: 'outcome',
    trigger: aggLastTrigger,
    detail: {
      result: 'failed-aggregate',
      code: aggCode,
      repeats: aggCount,
      window_sec: windowSec,
      note: `${aggCode} x${aggCount} in ${windowSec}s${halted ? ' — HALTED' : ''}`,
    },
  };
  pushRing(entry);
  console.error(fmt(entry));
  aggCode = null;
  aggCount = 0;
  aggFirstMs = 0;
  aggLastTrigger = undefined;
}

/**
 * Record one [AuthRC] event. Repeated identical failing outcomes are
 * aggregated rather than logged line-by-line.
 */
export function authRc(entry: Omit<AuthRcEntry, 'ts'>): void {
  const isRepeatableFailure =
    entry.phase === 'outcome' &&
    (entry.detail?.result === 'failed') &&
    typeof entry.detail?.code === 'string';

  if (isRepeatableFailure) {
    const code = entry.detail.code as string;
    if (aggCode === code) {
      aggCount += 1;
      aggLastTrigger = entry.trigger ?? aggLastTrigger;
      return; // collapse — do not emit a line per repeat
    }
    // a different code (or first failure) — flush any prior run, start new
    flushAggregate('code-change');
    aggCode = code;
    aggCount = 1;
    aggFirstMs = Date.now();
    aggLastTrigger = entry.trigger;
    // fall through: emit the FIRST occurrence so the storm's onset is visible
  } else if (aggCount > 0 && entry.phase === 'outcome') {
    // a non-failed outcome ends the run — summarize what came before
    flushAggregate('code-change');
  }

  const full: AuthRcEntry = { ts: new Date().toISOString(), ...entry };
  pushRing(full);

  // terminal-dead / short-circuit / reset are errors-worth-surfacing;
  // refreshed is normal; everything else informational.
  const line = fmt(full);
  if (
    full.phase === 'outcome' &&
    (full.detail?.result === 'terminal-dead' || full.detail?.result === 'failed')
  ) {
    console.error(line);
  } else if (full.phase === 'short-circuit') {
    console.warn(line);
  } else {
    console.log(line);
  }

  // Terminal-dead closes the storm: flush the aggregate with HALTED.
  if (full.phase === 'outcome' && full.detail?.result === 'terminal-dead') {
    flushAggregate('terminal');
  }
}

/** Recent ring-buffer for the sidecar diag endpoint (Deliverable D §5.6). */
export function getAuthRc(limit = 50): AuthRcEntry[] {
  flushAggregate('read'); // make any in-progress storm visible to the query
  const n = Math.max(1, Math.min(limit, RING_MAX));
  return ring.slice(-n);
}

/** Test/diagnostic helper — clears ring + aggregation state. */
export function _resetAuthRc(): void {
  ring.length = 0;
  aggCode = null;
  aggCount = 0;
  aggFirstMs = 0;
  aggLastTrigger = undefined;
}
