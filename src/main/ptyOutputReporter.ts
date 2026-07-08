/**
 * PTY output reporter.
 *
 * Taps raw node-pty output from acp-desktop and forwards it to the vsql-cache
 * backend at http://10.0.0.93:52424. vsql-cache normalizes the stream (strip
 * ANSI, scrub secrets) and re-emits it as `agent-output` SSE events that the
 * renderer consumes for the unified agent-overview UI.
 *
 * Batching: PTY output is high-frequency and byte-granular, so we coalesce
 * per-terminal chunks and flush on a short timer or when the buffer grows.
 * This keeps the HTTP overhead negligible without adding perceptible latency.
 */

import { isVsqlCacheReportingEnabled, postAgentOutput } from './vsql-cache-client';

interface PendingOutput {
  agentName: string;
  terminalId: string;
  provider?: string;
  projectId?: string;
  sessionId?: string;
  chunks: string[];
  timer: NodeJS.Timeout | null;
}

const FLUSH_INTERVAL_MS = 150;
const MAX_BUFFER_BYTES = 8192;

const pending = new Map<string, PendingOutput>();

// Drop-count logging for MVP (no retry queue). Logged periodically so a
// down vsql-cache backend does not flood the desktop console.
let dropCount = 0;
let dropBytes = 0;
let lastDropLog = Date.now();
const DROP_LOG_INTERVAL_MS = 30_000;

function makeKey(terminalId: string): string {
  return terminalId;
}

function recordDrop(bytes: number): void {
  dropCount++;
  dropBytes += bytes;
  const now = Date.now();
  if (now - lastDropLog > DROP_LOG_INTERVAL_MS) {
    console.warn(`[PtyOutput] Dropped ${dropCount} output report(s) (${dropBytes} bytes) since last log — vsql-cache unreachable or rejecting`);
    dropCount = 0;
    dropBytes = 0;
    lastDropLog = now;
  }
}

function flushEntry(key: string): void {
  const entry = pending.get(key);
  if (!entry || entry.chunks.length === 0) return;

  const data = entry.chunks.join('');
  entry.chunks.length = 0;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  if (!data) return;

  if (!isVsqlCacheReportingEnabled()) {
    return;
  }

  postAgentOutput({
    agentName: entry.agentName,
    terminalId: entry.terminalId,
    data,
    provider: entry.provider,
    projectId: entry.projectId,
    sessionId: entry.sessionId,
  }).catch(() => {
    recordDrop(Buffer.byteLength(data));
  });
}

export function reportPtyOutput(
  agentName: string,
  terminalId: string,
  data: string,
  provider?: string,
  projectId?: string,
  sessionId?: string,
): void {
  if (!data || !isVsqlCacheReportingEnabled()) return;

  const key = makeKey(terminalId);
  let entry = pending.get(key);
  if (!entry) {
    entry = {
      agentName,
      terminalId,
      provider,
      projectId,
      sessionId,
      chunks: [],
      timer: null,
    };
    pending.set(key, entry);
  }

  entry.chunks.push(data);

  const buffered = entry.chunks.reduce((sum, c) => sum + c.length, 0);
  if (buffered >= MAX_BUFFER_BYTES) {
    flushEntry(key);
    return;
  }

  if (!entry.timer) {
    entry.timer = setTimeout(() => flushEntry(key), FLUSH_INTERVAL_MS);
  }
}

/** Flush any pending output for a terminal. Call on PTY exit. */
export function flushPtyOutput(terminalId: string): void {
  flushEntry(makeKey(terminalId));
}

/** Drop pending output without sending. Call on terminal kill/reset. */
export function dropPtyOutput(terminalId: string): void {
  const key = makeKey(terminalId);
  const entry = pending.get(key);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(key);
}
