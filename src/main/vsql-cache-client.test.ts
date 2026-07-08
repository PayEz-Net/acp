/**
 * vsql-cache-client unit tests.
 *
 * Covers the graceful-disable behavior that prevents missing-config dev runs
 * from spamming the console once per PTY output chunk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getCurrentUserId } from './auth';

vi.mock('./auth', () => ({
  getCurrentUserId: vi.fn().mockResolvedValue('user-123'),
}));

async function loadModule() {
  const mod = await import('./vsql-cache-client');
  return mod;
}

describe('vsql-cache-client', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(getCurrentUserId).mockResolvedValue('user-123');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 202, statusText: 'Accepted' } as Response),
    );
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is disabled and warns once when VIBESQL_CONTAINER_SECRET is missing', async () => {
    vi.stubEnv('VIBESQL_CONTAINER_SECRET', '');
    // VSQL_CACHE_URL left unset so the only disable reason is the missing secret.
    const { isVsqlCacheReportingEnabled, postAgentOutput } = await loadModule();

    expect(isVsqlCacheReportingEnabled()).toBe(false);

    await postAgentOutput({ agentName: 'a', terminalId: 't1', data: 'chunk-1' });
    await postAgentOutput({ agentName: 'a', terminalId: 't1', data: 'chunk-2' });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('VIBESQL_CONTAINER_SECRET'),
    );
  });

  it('is disabled and warns once when VSQL_CACHE_URL is explicitly empty', async () => {
    vi.stubEnv('VIBESQL_CONTAINER_SECRET', 'super-secret');
    vi.stubEnv('VSQL_CACHE_URL', '');
    const { isVsqlCacheReportingEnabled, postAgentOutput } = await loadModule();

    expect(isVsqlCacheReportingEnabled()).toBe(false);

    await postAgentOutput({ agentName: 'a', terminalId: 't1', data: 'chunk' });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('VSQL_CACHE_URL'),
    );
  });

  it('uses the default URL and posts when only the secret is configured', async () => {
    vi.stubEnv('VIBESQL_CONTAINER_SECRET', 'super-secret');
    // VSQL_CACHE_URL unset => default http://10.0.0.93:52424
    delete process.env.VSQL_CACHE_URL;
    const { isVsqlCacheReportingEnabled, getVsqlCacheUrl, postAgentOutput } = await loadModule();

    expect(isVsqlCacheReportingEnabled()).toBe(true);
    expect(getVsqlCacheUrl()).toBe('http://10.0.0.93:52424');

    await postAgentOutput({
      agentName: 'DotNetPert',
      terminalId: 't1',
      data: 'hello',
      provider: 'local',
      projectId: 'proj-1',
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://10.0.0.93:52424/v1/agent-output');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Secret super-secret');
    expect(headers['X-Vibe-Project-Id']).toBe('proj-1');
    expect(headers['X-Vibe-User-Id']).toBe('user-123');

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      agentName: 'DotNetPert',
      terminalId: 't1',
      data: 'hello',
      provider: 'local',
    });
  });

  it('honors VSQL_CACHE_URL override when configured', async () => {
    vi.stubEnv('VIBESQL_CONTAINER_SECRET', 'super-secret');
    vi.stubEnv('VSQL_CACHE_URL', 'http://vsql-cache.test:9999');
    const { getVsqlCacheUrl, postAgentOutput } = await loadModule();

    expect(getVsqlCacheUrl()).toBe('http://vsql-cache.test:9999');

    await postAgentOutput({ agentName: 'a', terminalId: 't1', data: 'x' });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://vsql-cache.test:9999/v1/agent-output');
  });

  it('swallows 503 responses without throwing', async () => {
    vi.stubEnv('VIBESQL_CONTAINER_SECRET', 'super-secret');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' } as Response),
    );
    const { postAgentOutput } = await loadModule();

    await expect(
      postAgentOutput({ agentName: 'a', terminalId: 't1', data: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('throws on unexpected non-2xx responses', async () => {
    vi.stubEnv('VIBESQL_CONTAINER_SECRET', 'super-secret');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Oops' } as Response),
    );
    const { postAgentOutput } = await loadModule();

    await expect(
      postAgentOutput({ agentName: 'a', terminalId: 't1', data: 'x' }),
    ).rejects.toThrow('vsql-cache POST /v1/agent-output failed: 500 Oops');
  });

  it('uses the upstream cache URL from .env when both vars are set', async () => {
    vi.stubEnv('VSQL_CACHE_URL', 'http://10.0.0.220:52424');
    vi.stubEnv('VIBESQL_CONTAINER_SECRET', 'ContainersSuperDevSecret');
    const { isVsqlCacheReportingEnabled, getVsqlCacheUrl, postAgentOutput } = await loadModule();

    expect(isVsqlCacheReportingEnabled()).toBe(true);
    expect(getVsqlCacheUrl()).toBe('http://10.0.0.220:52424');

    await postAgentOutput({ agentName: 'a', terminalId: 't1', data: 'x' });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://10.0.0.220:52424/v1/agent-output');
  });
});
