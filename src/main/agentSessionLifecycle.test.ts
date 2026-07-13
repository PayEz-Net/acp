/**
 * PayEzVibe agent session lifecycle unit tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildVsqlCacheAuthHeaders, hasCapability } from './vsql-cache-client';

vi.mock('./vsql-cache-client', () => ({
  buildVsqlCacheAuthHeaders: vi.fn().mockResolvedValue({
    Authorization: 'Bearer test-token',
  }),
  hasCapability: vi.fn().mockResolvedValue(true),
}));

vi.mock('./env', () => ({
  VIBE_API_URL: 'https://api.idealvibe.online',
}));

async function loadModule() {
  const mod = await import('./agentSessionLifecycle');
  return mod;
}

function makeStartResponse(sessionId: string, token = 'tok') {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        success: true,
        data: { session: { id: sessionId, session_token: token, agent_id: 1 } },
      }),
  } as unknown as Response;
}

function makeOkResponse() {
  return { ok: true, status: 200 } as Response;
}

describe('agentSessionLifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.mocked(buildVsqlCacheAuthHeaders).mockResolvedValue({
      Authorization: 'Bearer test-token',
    });
    vi.mocked(hasCapability).mockResolvedValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeOkResponse()),
    );
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
    vi.spyOn(console, 'log').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts a session and returns its id/token/agentId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeStartResponse('sess-1')));
    const { startAgentSession, getAgentSession } = await loadModule();

    const result = await startAgentSession('term-1', 42);

    expect(result).toEqual({ ok: true, session: { id: 'sess-1', sessionToken: 'tok', agentId: 42 } });
    expect(getAgentSession('term-1')).toEqual({ id: 'sess-1', sessionToken: 'tok', agentId: 42 });
  });

  it('POSTs start with agentId, content-type and bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeStartResponse('sess-2'));
    vi.stubGlobal('fetch', fetchMock);
    const { startAgentSession } = await loadModule();

    await startAgentSession('term-2', 7);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.idealvibe.online/v1/sessions/start');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(init.body)).toEqual({ agent_id: 7 });
  });

  it('handles a flat session response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: { id: 'sess-flat', session_token: 'flat-tok', agent_id: 9 },
          }),
      } as unknown as Response),
    );
    const { startAgentSession } = await loadModule();

    const result = await startAgentSession('term-flat', 9);

    expect(result.ok && result.session.id).toBe('sess-flat');
  });

  it('POSTs start with agent_id and project_id when projectId is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeStartResponse('sess-proj'));
    vi.stubGlobal('fetch', fetchMock);
    const { startAgentSession } = await loadModule();

    await startAgentSession('term-proj', 7, 25);

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ agent_id: 7, project_id: 25 });
  });

  it('returns a 403 result when agent_terminal_output capability is missing', async () => {
    vi.mocked(hasCapability).mockResolvedValue(false);
    const fetchMock = vi.fn().mockResolvedValue(makeStartResponse('sess-cap'));
    vi.stubGlobal('fetch', fetchMock);
    const { startAgentSession } = await loadModule();

    const result = await startAgentSession('term-cap', 1);

    expect(result).toEqual({
      ok: false,
      status: 403,
      message: expect.stringContaining('agent_terminal_output'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a failed result and logs when start fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('boom'),
      } as Response),
    );
    const { startAgentSession } = await loadModule();

    const result = await startAgentSession('term-3', 1);

    expect(result).toEqual({ ok: false, status: 500, message: expect.stringContaining('HTTP 500') });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to start session'),
      expect.anything(),
    );
  });

  it('does not block on start failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    );
    const { startAgentSession } = await loadModule();

    await expect(startAgentSession('term-err', 1)).resolves.toEqual({
      ok: false,
      message: 'network down',
    });
  });

  it('sends heartbeat every 30 seconds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeStartResponse('sess-hb'))
      .mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { startAgentSession } = await loadModule();

    await startAgentSession('term-hb', 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.idealvibe.online/v1/sessions/sess-hb/heartbeat');
  });

  it('stops heartbeat after session end', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeStartResponse('sess-end'))
      .mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { startAgentSession, endAgentSession } = await loadModule();

    await startAgentSession('term-end', 3);
    await endAgentSession('term-end', 'killed');
    expect(fetchMock).toHaveBeenCalledTimes(2); // start + end

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ends session with reason query param', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeStartResponse('sess-reason'))
      .mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { startAgentSession, endAgentSession } = await loadModule();

    await startAgentSession('term-reason', 4);
    await endAgentSession('term-reason', 'teardown');

    const endCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/end'),
    );
    expect(endCalls).toHaveLength(1);
    expect(endCalls[0][0]).toBe(
      'https://api.idealvibe.online/v1/sessions/sess-reason/end?reason=teardown',
    );
  });

  it('stops heartbeat on 401/403 and does not retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeStartResponse('sess-auth'))
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { startAgentSession } = await loadModule();

    await startAgentSession('term-auth', 5);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores duplicate start for the same terminal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeStartResponse('sess-dup'));
    vi.stubGlobal('fetch', fetchMock);
    const { startAgentSession } = await loadModule();

    const first = await startAgentSession('term-dup', 6);
    const second = await startAgentSession('term-dup', 6);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('queues end while start is in flight and ends after start resolves', async () => {
    let resolveStart: (value: unknown) => void;
    const startPromise = new Promise((resolve) => {
      resolveStart = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(() => startPromise);
    vi.stubGlobal('fetch', fetchMock);
    const { startAgentSession, endAgentSession } = await loadModule();

    const started = startAgentSession('term-pending', 8);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks up to sendStart await
    await endAgentSession('term-pending', 'normal');

    resolveStart!(
      makeStartResponse('sess-pending'),
    );
    await started;
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((resolve) => process.nextTick(resolve));
    console.log('fetch calls', fetchMock.mock.calls);

    const endCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/end'),
    );
    expect(endCalls).toHaveLength(1);
    expect(endCalls[0][0]).toContain('reason=normal');
  });
});
