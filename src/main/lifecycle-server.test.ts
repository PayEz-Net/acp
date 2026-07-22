import { describe, it, expect, vi, afterEach } from 'vitest';

// WO 11469 (a): the Electron lifecycle callback must accept `model` on
// /internal/pty/spawn and pass it to spawnAgent as modelOverride — without it
// a hand-spawned kimi agent never satisfies the k3 effort gate.
const mocks = vi.hoisted(() => ({
  spawnAgent: vi.fn((_agentName: string, _workDir: string, _opts?: Record<string, unknown>) => 't-mock-1'),
  killTerminal: vi.fn(() => true),
  resizeTerminal: vi.fn(() => true),
  getAgentSessionByAgent: vi.fn(() => null),
  getActiveTerminals: vi.fn(() => []),
  setOnPtyExit: vi.fn(),
  getLocalSecret: vi.fn(() => 'test-secret'),
  getSettings: vi.fn(() => ({})),
}));

vi.mock('./pty', () => ({
  spawnAgent: mocks.spawnAgent,
  killTerminal: mocks.killTerminal,
  resizeTerminal: mocks.resizeTerminal,
  getAgentSessionByAgent: mocks.getAgentSessionByAgent,
  getActiveTerminals: mocks.getActiveTerminals,
  setOnPtyExit: mocks.setOnPtyExit,
  WorkDirError: class WorkDirError extends Error {},
  RuntimeNotSetError: class RuntimeNotSetError extends Error {},
}));

vi.mock('./api-server', () => ({
  getLocalSecret: mocks.getLocalSecret,
}));

vi.mock('./store', () => ({
  getSettings: mocks.getSettings,
}));

import { startLifecycleServer, stopLifecycleServer } from './lifecycle-server';

async function postSpawn(body: Record<string, unknown>): Promise<Response> {
  const port = await startLifecycleServer();
  if (!port) throw new Error('lifecycle server failed to bind');
  return fetch(`http://127.0.0.1:${port}/internal/pty/spawn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret',
    },
    body: JSON.stringify(body),
  });
}

describe('lifecycle-server /internal/pty/spawn model pass-through (WO 11469)', () => {
  afterEach(() => {
    stopLifecycleServer();
    vi.clearAllMocks();
  });

  it('passes model through to spawnAgent as modelOverride', async () => {
    const res = await postSpawn({
      agentName: 'NextPert',
      workDir: '/repo',
      runtime: 'kimi',
      effort: 'high',
      model: 'k3',
      projectId: 7,
    });

    expect(res.status).toBe(200);
    expect(mocks.spawnAgent).toHaveBeenCalledWith(
      'NextPert',
      '/repo',
      expect.objectContaining({
        runtime: 'kimi',
        effort: 'high',
        modelOverride: 'k3',
        projectId: 7,
      }),
    );
  });

  it('leaves modelOverride undefined when model is absent or blank (inherit)', async () => {
    const res = await postSpawn({
      agentName: 'NextPert',
      workDir: '/repo',
      runtime: 'kimi',
      model: '   ',
    });

    expect(res.status).toBe(200);
    const opts = mocks.spawnAgent.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.modelOverride).toBeUndefined();
  });
});
