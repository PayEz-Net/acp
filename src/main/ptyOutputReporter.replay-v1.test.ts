/**
 * Terminal Replay v1 — desktop PTY output cloud write + retry harness.
 *
 * Verifies that reportPtyOutput:
 *   1. POSTs the batched chunk to the PayEzVibe API /v1/agent-output.
 *   2. Includes an idempotencyKey in the request body.
 *   3. Retries transient failures, reusing the same idempotency key.
 *   4. No longer dual-writes to the local acp-api sidecar.
 *
 * Run: npm test -- ptyOutputReporter.replay-v1
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

describe('ptyOutputReporter.replay-v1', () => {
  let fetchSpy: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.mocked(getAccessToken).mockResolvedValue('bearer-token-123');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/v1/agent-output')) {
        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes PTY output to the PayEzVibe API with an idempotency key', async () => {
    const { reportPtyOutput } = await loadReporter();

    reportPtyOutput('BAPert', 't1', 'hello replay v1', 'claude', '42', 'sess-1', 'token-1');
    await vi.advanceTimersByTimeAsync(150);
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.idealvibe.online/v1/agent-output');
    expect(init?.method).toBe('POST');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body).toEqual({
      agentName: 'BAPert',
      terminalId: 't1',
      data: 'hello replay v1',
      provider: 'claude',
      sessionToken: 'token-1',
      idempotencyKey: expect.any(String),
    });
    expect(body.idempotencyKey).toBeTruthy();

    // No local sidecar write should happen.
    const localCall = fetchSpy.mock.calls.find((call) => {
      const u = String(call[0]);
      return u.includes('/internal/pty/output') || u.includes('/internal/pty/mark-synced');
    });
    expect(localCall).toBeUndefined();
  });

  it('retries cloud failures instead of dropping them', async () => {
    // First cloud POST fails with 503; subsequent ones succeed.
    let attempts = 0;
    let capturedKey = '';
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (body.idempotencyKey && body.idempotencyKey !== capturedKey) {
        capturedKey = body.idempotencyKey;
      }
      attempts += 1;
      if (attempts === 1) {
        return new Response(
          JSON.stringify({ success: false }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { reportPtyOutput } = await loadReporter();

    reportPtyOutput('BAPert', 't2', 'retry me', 'claude', '42', 'sess-1');
    await vi.advanceTimersByTimeAsync(150);
    await Promise.resolve();

    // 503 is swallowed initially, then retry queue fires after 1s.
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    expect(attempts).toBeGreaterThanOrEqual(2);
    // The retry must reuse the same idempotency key.
    const cloudCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/v1/agent-output'),
    );
    const keys = cloudCalls.map((call) => {
      const body = JSON.parse((call[1]?.body as string) ?? '{}');
      return body.idempotencyKey;
    });
    expect(new Set(keys).size).toBe(1);
  });
});
