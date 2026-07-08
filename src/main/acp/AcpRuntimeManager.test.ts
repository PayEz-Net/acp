import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { AcpRuntimeManager } from './AcpRuntimeManager';
import { getProviderConfig } from './providerConfigs';
import type { AcpEventPayload } from '../../shared/acpTypes';

interface MockAcpProcess {
  started: boolean;
  requests: Array<{ method: string; params: unknown }>;
  notifications: Array<{ method: string; params: unknown }>;
  responses: Array<{ id: number | string; result: unknown }>;
  killed: boolean;
  start(): void;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  respond(id: number | string, result: unknown): void;
  kill(): void;
  isRunning(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

const mockState = vi.hoisted(() => ({
  responses: new Map<string, unknown | Error>(),
  lastInstance: null as MockAcpProcess | null,
  setResponse(method: string, value: unknown | Error) {
    mockState.responses.set(method, value);
  },
}));

vi.mock('./AcpProcess', () => ({
  AcpProcess: class extends EventEmitter {
    started = false;
    requests: Array<{ method: string; params: unknown }> = [];
    notifications: Array<{ method: string; params: unknown }> = [];
    responses: Array<{ id: number | string; result: unknown }> = [];
    killed = false;

    constructor() {
      super();
      mockState.lastInstance = this as unknown as MockAcpProcess;
    }

    start(): void {
      this.started = true;
    }

    async request(method: string, params?: unknown): Promise<unknown> {
      this.requests.push({ method, params });
      const response = mockState.responses.get(method);
      if (response instanceof Error) throw response;
      return response;
    }

    notify(method: string, params?: unknown): void {
      this.notifications.push({ method, params });
    }

    respond(id: number | string, result: unknown): void {
      this.responses.push({ id, result });
    }

    kill(): void {
      this.killed = true;
    }

    isRunning(): boolean {
      return !this.killed;
    }
  },
}));

describe('AcpRuntimeManager', () => {
  let manager: AcpRuntimeManager;
  let events: AcpEventPayload[] = [];

  beforeEach(() => {
    mockState.responses.clear();
    mockState.lastInstance = null;
    events = [];
    manager = new AcpRuntimeManager('rt-1', getProviderConfig('kimi'), {
      agentName: 'NextPert',
      workDir: '/repo',
      projectId: 42,
    });
    manager.on('event', (payload: AcpEventPayload) => events.push(payload));
  });

  function getProcess(): MockAcpProcess {
    return mockState.lastInstance ?? ({} as MockAcpProcess);
  }

  it('initializes and emits initialized event', async () => {
    mockState.setResponse('initialize', {
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'Kimi', version: '1.0' },
    });
    mockState.setResponse('session/new', { sessionId: 'sess-1' });

    await manager.start();

    expect(manager.isInitialized()).toBe(true);
    expect(manager.getSessionId()).toBe('sess-1');
    const initialized = events.find((e) => e.update.sessionUpdate === 'initialized');
    expect(initialized).toBeDefined();
    expect(initialized?.update).toMatchObject({
      sessionUpdate: 'initialized',
      sessionId: 'sess-1',
      capabilities: { loadSession: true },
      agentInfo: { name: 'Kimi', version: '1.0' },
    });
  });

  it('requests available commands after session init', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-2' });

    await manager.start();

    expect(getProcess().notifications).toContainEqual(
      expect.objectContaining({ method: 'session/list_commands' }),
    );
  });

  it('sends a prompt via session/prompt', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-3' });
    await manager.start();

    await manager.prompt('hello');

    expect(getProcess().requests).toContainEqual(
      expect.objectContaining({ method: 'session/prompt' }),
    );
  });

  it('cancels the active turn', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-4' });
    await manager.start();

    manager.cancel();

    expect(getProcess().notifications).toContainEqual(
      expect.objectContaining({ method: 'session/cancel' }),
    );
  });

  it('sets a session mode', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-5' });
    await manager.start();

    manager.setMode('code');

    expect(getProcess().notifications).toContainEqual(
      expect.objectContaining({ method: 'session/set_mode', params: expect.objectContaining({ modeId: 'code' }) }),
    );
  });

  it('emits permission_request and responds when approved', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-6' });
    await manager.start();

    getProcess().emit('notification', 'session/request_permission', {
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
      toolCall: { toolCallId: 'tc1', title: 'Shell', status: 'in_progress', content: [] },
    }, 99);

    const permissionEvent = events.find((e) => e.update.sessionUpdate === 'permission_request');
    expect(permissionEvent).toBeDefined();
    expect(permissionEvent?.update).toMatchObject({ requestId: 99 });

    manager.respondToPermission(99, 'allow');
    expect(getProcess().responses).toContainEqual(
      expect.objectContaining({
        id: 99,
        result: expect.objectContaining({
          outcome: expect.objectContaining({ outcome: 'selected', optionId: 'allow' }),
        }),
      }),
    );
  });

  it('forwards streamed message chunks', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-7' });
    await manager.start();

    getProcess().emit('notification', 'session/update', {
      sessionId: 'sess-7',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'content', content: { type: 'text', text: 'Hi' } },
      },
    });

    expect(events.some((e) => e.update.sessionUpdate === 'agent_message_chunk')).toBe(true);
  });

  it('emits error when initialization fails', async () => {
    mockState.setResponse('initialize', new Error('initialize failed'));

    await expect(manager.start()).rejects.toThrow('initialize failed');

    expect(events.some((e) => e.update.sessionUpdate === 'error')).toBe(true);
  });

  it('kills the underlying process', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-8' });
    await manager.start();

    manager.kill();
    expect(getProcess().killed).toBe(true);
  });
});
