/**
 * PTY output reporter.
 *
 * Taps raw node-pty output from acp-desktop and forwards it to the PayEzVibe
 * API (VIBE_API_URL), which authenticates the user and forwards to the internal
 * cache service. The cache service normalizes the stream (strip ANSI, scrub
 * secrets) and re-emits it as `agent-output` SSE events that the renderer
 * consumes for the unified agent-overview UI.
 *
 * Batching: PTY output is high-frequency and byte-granular, so we coalesce
 * per-terminal chunks and flush on a short timer or when the buffer grows.
 * This keeps the HTTP overhead negligible without adding perceptible latency.
 *
 * Idempotency: each logical flush generates an opaque idempotency key. Retries
 * reuse the same key so transient failures do not create duplicate rows in the
 * backend cache.
 */

import { getAccessToken } from './auth';
import { VIBE_API_URL } from './env';

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

interface RetryItem {
  payload: CloudOutputPayload;
  idempotencyKey: string;
  attempts: number;
  timer: NodeJS.Timeout | null;
}

const retryQueue: RetryItem[] = [];

// Drop-count logging for MVP. Logged periodically so a down PayEzVibe API
// backend does not flood the desktop console.
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
    console.warn(`[PtyOutput] Dropped ${dropCount} output report(s) (${dropBytes} bytes) since last log — PayEzVibe API unreachable or rejecting`);
    dropCount = 0;
    dropBytes = 0;
    lastDropLog = now;
  }
}

function makeIdempotencyKey(): string {
  return `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * POST raw PTY output to the PayEzVibe API.
 *
 * Throws on any non-2xx response (including 503) so the caller can schedule a
 * retry with the same idempotency key. PTY output must never crash the desktop,
 * so the caller catches and queues retries rather than surfacing the error.
 */
async function postAgentOutput(payload: CloudOutputPayload, idempotencyKey: string): Promise<void> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('No authenticated user token available');
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
    throw new Error(`vibe-api POST /v1/agent-output failed: ${res.status} ${res.statusText}`);
  }
}

function scheduleRetry(payload: CloudOutputPayload, idempotencyKey: string, attempts: number): void {
  if (attempts >= MAX_RETRIES) {
    recordDrop(Buffer.byteLength(payload.data));
    return;
  }
  const delay = Math.min(RETRY_BASE_MS * Math.pow(2, attempts), RETRY_MAX_MS);
  const item: RetryItem = { payload, idempotencyKey, attempts, timer: null };
  retryQueue.push(item);
  item.timer = setTimeout(() => { void processRetry(item); }, delay);
}

async function processRetry(item: RetryItem): Promise<void> {
  const idx = retryQueue.indexOf(item);
  if (idx >= 0) retryQueue.splice(idx, 1);
  try {
    await postAgentOutput(item.payload, item.idempotencyKey);
  } catch (err: any) {
    console.warn(`[PtyOutput] Retry failed for ${item.payload.agentName}:`, err.message);
    scheduleRetry(item.payload, item.idempotencyKey, item.attempts + 1);
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
    console.warn(`[PtyOutput] PayEzVibe API post failed for ${entry.agentName}:`, err.message);
    scheduleRetry(payload, idempotencyKey, 0);
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

/** Drop pending output without sending. Call on terminal kill/reset. */
export function dropPtyOutput(terminalId: string): void {
  const key = makeKey(terminalId);
  const entry = pending.get(key);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(key);

  // Cancel any queued retries for this terminal.
  for (let i = retryQueue.length - 1; i >= 0; i--) {
    const item = retryQueue[i];
    if (item.payload.terminalId === terminalId) {
      if (item.timer) clearTimeout(item.timer);
      retryQueue.splice(i, 1);
    }
  }
}
