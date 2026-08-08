/**
 * 184947/184984 — what actually lands in the on-disk spill queue.
 *
 * Verifies the wiring between ptyOutputReporter's spillOrDrop and
 * outputSpill: a payload that exhausts its in-memory retries is spilled
 * WITH its failure cause/attempts (184947) and WITHOUT its sessionToken in
 * plaintext (184984).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAccessToken } from './auth';

vi.mock('./auth', () => ({
  getAccessToken: vi.fn().mockResolvedValue('bearer-token-123'),
}));

vi.mock('./env', () => ({
  VIBE_API_URL: 'https://api.idealvibe.online',
}));

async function loadReporter() {
  vi.resetModules();
  const mod = await import('./ptyOutputReporter');
  return mod;
}

let dir: string;

describe('ptyOutputReporter -> outputSpill wiring', () => {
  let fetchSpy: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spill-wiring-'));
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.mocked(getAccessToken).mockResolvedValue('bearer-token-123');
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('spills a payload that exhausts retries WITH cause/attempts and WITHOUT the plaintext sessionToken', async () => {
    // Always 503 — retryable, so it walks the full retry ladder to spill
    // rather than recording an immediate permanent drop.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ success: false }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { reportPtyOutput, initOutputSpill } = await loadReporter();
    initOutputSpill(dir, 1_000_000); // huge drain interval — this test only cares about the SPILL write, not drain
    const spillDir = path.join(dir, 'agent-output-spill'); // initOutputSpill's own subdir convention

    reportPtyOutput('BAPert', 't-spill', 'content that must not leak its token', 'claude', '42', 'sess-1', 'super-secret-session-token');

    // Initial flush + full retry ladder: 150ms flush, then 1s/2s/4s/8s/16s
    // (RETRY_BASE_MS * 2^attempts, MAX_RETRIES = 5) before spillOrDrop fires.
    await vi.advanceTimersByTimeAsync(150);
    for (const delay of [1000, 2000, 4000, 8000, 16000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await Promise.resolve();
    }
    // spillOrDrop's disk write is real fs I/O (fire-and-forget from
    // processRetry), which fake timers do not drive — drop to the real
    // event loop briefly so it can actually complete.
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const files = (await fs.readdir(spillDir)).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);

    const entry = JSON.parse(await fs.readFile(path.join(spillDir, files[0]), 'utf8'));

    // 184947: the failure cause survived onto disk instead of being thrown away.
    expect(entry.cause).toBe('server-error');
    expect(typeof entry.attempts).toBe('number');

    // 184984: the credential did NOT get written to disk in plaintext.
    expect(entry.payload.sessionToken).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('super-secret-session-token');

    // The rest of the payload is intact — redaction removed exactly one field.
    expect(entry.payload.agentName).toBe('BAPert');
    expect(entry.payload.data).toBe('content that must not leak its token');
  });

  // --- 140734/185071: the REAL runDrain wiring, not just outputSpill's unit
  // tests. QAPert's 185071 finding was exactly this gap: the classify logic
  // was correct and unit-tested in isolation, but runDrain never passed a
  // classifier at all, so nothing was ever reachable in the running app.
  // This drives drainSpill through the actual runDrain() code path.
  it('runDrain classifies a terminal (non-retryable) failure and dead-letters it after repeated ticks', async () => {
    vi.useRealTimers(); // real interval ticks — this test IS the wiring check

    const spillDir = path.join(dir, 'agent-output-spill');
    await fs.mkdir(spillDir, { recursive: true });
    const preSpilled = {
      payload: { agentName: 'BAPert', terminalId: 't-poison', data: 'poison payload', provider: 'claude' },
      idempotencyKey: 'poison-key',
      spilledAt: 1000,
    };
    await fs.writeFile(path.join(spillDir, '000000000001000-000000.json'), JSON.stringify(preSpilled), 'utf8');

    // 400 with no retryable code -> ptyOutputReporter's own isRetryable()
    // returns false -> classified 'terminal', not 'retryable'.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: { code: 'MALFORMED_BODY' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { initOutputSpill } = await loadReporter();
    initOutputSpill(dir, 5); // fast real ticks so the test doesn't wait on DEFAULT_MAX_DRAIN_ATTEMPTS x a real 15s interval

    // DEFAULT_MAX_DRAIN_ATTEMPTS is 10 — generous margin past that many ticks,
    // widened further (500ms -> 1500ms) after an observed flake when the full
    // suite runs in parallel and real setTimeout ticks contend with other
    // test files' I/O.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const deadLetterDir = path.join(spillDir, 'dead-letter');
    const deadFiles = await fs.readdir(deadLetterDir).catch(() => [] as string[]);
    expect(deadFiles.length).toBeGreaterThan(0);

    const liveFiles = (await fs.readdir(spillDir)).filter((f) => f.endsWith('.json'));
    expect(liveFiles).toHaveLength(0); // no longer blocking the live queue
  });
});
