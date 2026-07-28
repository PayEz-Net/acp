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
