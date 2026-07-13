/**
 * vsql-cache-client unit tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getAccessToken, getCurrentUserId } from './auth';

vi.mock('./auth', () => ({
  getAccessToken: vi.fn().mockResolvedValue('bearer-token-123'),
  getCurrentUserId: vi.fn().mockResolvedValue('user-123'),
}));

vi.mock('./env', () => ({
  VIBE_API_URL: 'https://api.idealvibe.online',
}));

async function loadModule() {
  const mod = await import('./vsql-cache-client');
  return mod;
}

describe('vsql-cache-client', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(getAccessToken).mockResolvedValue('bearer-token-123');
    vi.mocked(getCurrentUserId).mockResolvedValue('user-123');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 202, statusText: 'Accepted' } as Response),
    );
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports to the PayEzVibe API', async () => {
    const { postAgentOutput } = await loadModule();

    await postAgentOutput({
      agentName: 'DotNetPert',
      terminalId: 't1',
      data: 'hello',
      provider: 'local',
      projectId: 'proj-1',
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.idealvibe.online/v1/agent-output');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer bearer-token-123');
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

  it('throws when no access token is available', async () => {
    vi.mocked(getAccessToken).mockResolvedValue(null);
    const { postAgentOutput } = await loadModule();

    await expect(
      postAgentOutput({ agentName: 'a', terminalId: 't1', data: 'x' }),
    ).rejects.toThrow('No authenticated user token available');
  });

  it('swallows 503 responses without throwing', async () => {
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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Oops' } as Response),
    );
    const { postAgentOutput } = await loadModule();

    await expect(
      postAgentOutput({ agentName: 'a', terminalId: 't1', data: 'x' }),
    ).rejects.toThrow('vibe-api POST /v1/agent-output failed: 500 Oops');
  });
});
