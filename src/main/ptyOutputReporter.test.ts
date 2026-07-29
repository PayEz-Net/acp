/**
 * PTY output reporter unit tests.
 *
 * Verifies batching, flushing, idempotency-key retry, and drop handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
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

describe('ptyOutputReporter', () => {
  let fetchSpy: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.mocked(getAccessToken).mockResolvedValue('bearer-token-123');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('batches chunks and flushes after the interval', async () => {
    const { reportPtyOutput } = await loadReporter();

    reportPtyOutput('DotNetPert', 't1', 'a');
    reportPtyOutput('DotNetPert', 't1', 'b');
    reportPtyOutput('DotNetPert', 't1', 'c');
    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(150);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.idealvibe.online/v1/agent-output');
    expect(init?.method).toBe('POST');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body).toMatchObject({
      agentName: 'DotNetPert',
      terminalId: 't1',
      data: 'abc',
    });
    expect(body.idempotencyKey).toBeTruthy();
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer bearer-token-123',
      'Content-Type': 'application/json',
    });
  });

  it('flushes immediately when the buffer reaches the byte threshold', async () => {
    const { reportPtyOutput } = await loadReporter();
    const chunk = 'x'.repeat(8192);

    reportPtyOutput('DotNetPert', 't1', chunk);

    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0][1]?.body as string) ?? '{}');
    expect(body.data).toBe(chunk);
  });

  it('flushPtyOutput sends pending chunks immediately', async () => {
    const { reportPtyOutput, flushPtyOutput } = await loadReporter();

    reportPtyOutput('DotNetPert', 't1', 'now');
    expect(fetchSpy).not.toHaveBeenCalled();

    flushPtyOutput('t1');
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0][1]?.body as string) ?? '{}');
    expect(body.data).toBe('now');
  });

  it('dropPtyOutput discards pending chunks without sending', async () => {
    const { reportPtyOutput, dropPtyOutput } = await loadReporter();

    reportPtyOutput('DotNetPert', 't1', 'lost');
    dropPtyOutput('t1');
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('retries failed cloud posts with the same idempotency key', async () => {
    let attempts = 0;
    let capturedKey = '';
    fetchSpy.mockImplementation(async (_url, init) => {
      attempts += 1;
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (attempts === 1) {
        capturedKey = body.idempotencyKey;
        return new Response(JSON.stringify({ success: false }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      expect(body.idempotencyKey).toBe(capturedKey);
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const { reportPtyOutput } = await loadReporter();
    reportPtyOutput('DotNetPert', 't1', 'retry me', 'claude', '42', 'sess-1', 'token-1');
    await vi.advanceTimersByTimeAsync(150);

    expect(attempts).toBe(1);

    // First retry fires after 1s.
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBe(2);
  });

  it('does not retry a 4xx — the same body is rejected identically', async () => {
    let attempts = 0;
    fetchSpy.mockImplementation(async () => {
      attempts += 1;
      return new Response(JSON.stringify({ success: false }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    });

    const { reportPtyOutput } = await loadReporter();
    reportPtyOutput('DotNetPert', 't1', '\r\n', 'claude');
    await vi.advanceTimersByTimeAsync(150);
    expect(attempts).toBe(1);

    // Full retry ladder (1s + 2s + 4s + 8s + 16s) must produce no further posts.
    await vi.advanceTimersByTimeAsync(32_000);
    expect(attempts).toBe(1);
  });

  it('retries a 429 — a 4xx that describes a transient condition', async () => {
    let attempts = 0;
    fetchSpy.mockImplementation(async () => {
      attempts += 1;
      return new Response(JSON.stringify({ success: false }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    });

    const { reportPtyOutput } = await loadReporter();
    reportPtyOutput('DotNetPert', 't1', 'slow down', 'claude');
    await vi.advanceTimersByTimeAsync(150);
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBe(2);
  });

  // Regression guard. Both of the following are HTTP 400 and they demand opposite
  // verdicts, so the discriminator has to be the backend error code, not the status.
  // Measured 2026-07-29: all 24 boot-window drops preceded their terminal's
  // AgentSession start and none followed it — the session simply did not exist yet.
  it('retries a 400 AGENT_SESSION_NOT_FOUND — the session is created moments later', async () => {
    let attempts = 0;
    fetchSpy.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(
          JSON.stringify({ success: false, error: { code: 'AGENT_SESSION_NOT_FOUND', message: 'No active session for agent BAPert' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const { reportPtyOutput } = await loadReporter();
    reportPtyOutput('BAPert', 't-session-race', 'boot output', 'claude');
    await vi.advanceTimersByTimeAsync(150);
    expect(attempts).toBe(1);

    // Recovers on the ladder rather than dropping, which is the whole point.
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBe(2);
  });

  it('does not retry a 400 whose body carries no retryable code', async () => {
    let attempts = 0;
    fetchSpy.mockImplementation(async () => {
      attempts += 1;
      return new Response(
        JSON.stringify({ success: false, error: { code: 'INVALID_PROVIDER', message: 'Provider must be one of: claude, kimi, codex' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { reportPtyOutput } = await loadReporter();
    reportPtyOutput('DotNetPert', 't-bad-body', 'nope', 'claude');
    await vi.advanceTimersByTimeAsync(150);
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(32_000);
    expect(attempts).toBe(1);
  });

  it('survives a 4xx whose body is empty or unparseable', async () => {
    let attempts = 0;
    fetchSpy.mockImplementation(async () => {
      attempts += 1;
      return new Response('<html>502 gateway</html>', { status: 400 });
    });

    const { reportPtyOutput } = await loadReporter();
    reportPtyOutput('Aurum', 't-junk-body', 'x', 'claude');
    await vi.advanceTimersByTimeAsync(150);

    // No code parsed -> falls back to status-only handling (permanent), and
    // critically does not throw while reading the body.
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(32_000);
    expect(attempts).toBe(1);
  });

  it('does not log per-chunk warnings when cloud post fails', async () => {
    fetchSpy.mockRejectedValue(new Error('backend down'));
    const { reportPtyOutput } = await loadReporter();

    reportPtyOutput('DotNetPert', 't1', 'a');
    reportPtyOutput('DotNetPert', 't1', 'b');
    await vi.advanceTimersByTimeAsync(150);

    // The reporter may aggregate drops, but it must not emit a warning for
    // every individual failed chunk.
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to report output'),
    );
  });
});

/**
 * Drop accounting.
 *
 * These exist so a replay-capture audit can answer "what was lost, from which
 * terminal, and why" — in particular whether boot-window output is lost to auth
 * timing. Loss itself is expected under a down backend; unattributable loss is
 * the defect.
 */
describe('ptyOutputReporter drop accounting', () => {
  let fetchSpy: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>;

  // Full retry ladder before a drop is recorded: 1 + 2 + 4 + 8 + 16 = 31s.
  const LADDER_MS = 31_000;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.mocked(getAccessToken).mockResolvedValue('bearer-token-123');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attributes an auth-timing loss to its terminal with cause=no-token', async () => {
    vi.mocked(getAccessToken).mockResolvedValue(null);
    const { reportPtyOutput, getDropStats } = await loadReporter();

    reportPtyOutput('BAPert', 'term-a', 'boot output', 'claude');
    await vi.advanceTimersByTimeAsync(150 + LADDER_MS);

    const stats = getDropStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ agentName: 'BAPert', terminalId: 'term-a', drops: 1 });
    expect(stats[0].byCause['no-token']).toBe(1);
    // The boot-window signal: how far into the terminal's life the loss began.
    expect(stats[0].firstDropOffsetMs).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('DROP agent=BAPert terminal=term-a'),
    );
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cause=no-token'));
  });

  it('separates a 5xx backend outage from a 4xx rejection', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ success: false }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    );
    const { reportPtyOutput, getDropStats } = await loadReporter();

    reportPtyOutput('QAPert', 'term-r', 'rejected body', 'claude');
    await vi.advanceTimersByTimeAsync(150);

    const stats = getDropStats();
    expect(stats[0].byCause.rejected).toBe(1);
    expect(stats[0].byCause['server-error']).toBeUndefined();
  });

  it('keeps accounting separate per terminal', async () => {
    vi.mocked(getAccessToken).mockResolvedValue(null);
    const { reportPtyOutput, getDropStats } = await loadReporter();

    reportPtyOutput('BAPert', 'term-a', 'aaa', 'claude');
    reportPtyOutput('QAPert', 'term-b', 'bbbbbb', 'claude');
    await vi.advanceTimersByTimeAsync(150 + LADDER_MS);

    const stats = getDropStats().sort((x, y) => x.terminalId.localeCompare(y.terminalId));
    expect(stats.map((s) => s.terminalId)).toEqual(['term-a', 'term-b']);
    expect(stats[0].agentName).toBe('BAPert');
    expect(stats[0].bytes).toBe(3);
    expect(stats[1].agentName).toBe('QAPert');
    expect(stats[1].bytes).toBe(6);
  });

  it('accounts content discarded by dropPtyOutput rather than losing it silently', async () => {
    const { reportPtyOutput, dropPtyOutput, getDropStats } = await loadReporter();

    reportPtyOutput('NextPert', 'term-c', 'lost bytes', 'claude');
    dropPtyOutput('term-c');

    const stats = getDropStats();
    expect(stats).toHaveLength(1);
    expect(stats[0].byCause.cancelled).toBe(1);
    expect(stats[0].bytes).toBe(Buffer.byteLength('lost bytes'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cause=cancelled'));
  });

  it('reports the tail of a drop burst on a timer, not on the next drop', async () => {
    // Regression: the previous counter only flushed when a NEW drop arrived
    // more than 30s after the last log, so a burst that stopped — the backend
    // recovering after boot — was never reported at all.
    vi.mocked(getAccessToken).mockResolvedValue(null);
    const { reportPtyOutput, getDropStats } = await loadReporter();

    const big = 'x'.repeat(8192); // >= MAX_BUFFER_BYTES forces an immediate flush
    for (let i = 0; i < 26; i++) reportPtyOutput('BAPert', 'term-d', big, 'claude');
    await vi.advanceTimersByTimeAsync(150 + LADDER_MS);
    expect(getDropStats()[0].drops).toBe(26);

    // No further drops arrive. The tail past the detail cap must still surface.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('DROP rollup'));
  });
});
