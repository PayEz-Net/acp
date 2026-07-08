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
      expect.objectContaining({
        method: 'session/prompt',
        params: expect.objectContaining({
          sessionId: 'sess-3',
          prompt: [{ type: 'text', text: 'hello' }],
        }),
      }),
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

  it('filters streaming metadata artifacts from content chunks', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-artifacts' });
    await manager.start();

    getProcess().emit('notification', 'session/update', {
      sessionId: 'sess-artifacts',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'content',
          content: {
            type: 'text',
            text: "Before\n13 tokens :\n321:46\n:58\n70':\n1s · 82 tokens:96\n106 tokens: : 18\n31\n42\n30394\nAfter",
          },
        },
      },
    });

    const message = events.find((e) => e.update.sessionUpdate === 'agent_message_chunk');
    expect(message).toBeDefined();
    const text = ((message?.update as Record<string, unknown>)?.content as Record<string, unknown> | undefined)?.content as
      | Record<string, unknown>
      | undefined;
    expect(text?.text).toBe('Before\nAfter');
  });

  it('filters inline token counter fragments without stripping legitimate numbers', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-inline' });
    await manager.start();

    getProcess().emit('notification', 'session/update', {
      sessionId: 'sess-inline',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'content',
          content: {
            type: 'text',
            text: 'Run 3+ back-and-forth prompts in 2026. 14 tokens : here. Version 1.2.3 is OK.',
          },
        },
      },
    });

    const message = events.find((e) => e.update.sessionUpdate === 'agent_message_chunk');
    const text = ((message?.update as Record<string, unknown>)?.content as Record<string, unknown> | undefined)?.content as
      | Record<string, unknown>
      | undefined;
    expect(text?.text).toBe('Run 3+ back-and-forth prompts in 2026. here. Version 1.2.3 is OK.');
  });

  it('sanitizes ANSI/backspace/CR sequences inside nested content blocks', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-9' });
    await manager.start();

    getProcess().emit('notification', 'session/update', {
      sessionId: 'sess-9',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'content',
          content: {
            type: 'text',
            text: '\u001b[32mapplied\u001b[0m\r\nsame\b\b\bturn\n\u001b[1K slipping',
          },
        },
      },
    });

    const message = events.find((e) => e.update.sessionUpdate === 'agent_message_chunk');
    expect(message).toBeDefined();
    const text = ((message?.update as Record<string, unknown>)?.content as Record<string, unknown> | undefined)?.content as
      | Record<string, unknown>
      | undefined;
    expect(text?.text).toBe('applied\nsturn\n slipping');
  });

  it('preserves standalone numbers when no status artifacts are present', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-standalone' });
    await manager.start();

    getProcess().emit('notification', 'session/update', {
      sessionId: 'sess-standalone',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'content',
          content: {
            type: 'text',
            text: 'The answer is 42.\nA small count is 123.\nA year is 2026.\nVersion 1.2.3 works.',
          },
        },
      },
    });

    const message = events.find((e) => e.update.sessionUpdate === 'agent_message_chunk');
    const text = ((message?.update as Record<string, unknown>)?.content as Record<string, unknown> | undefined)?.content as
      | Record<string, unknown>
      | undefined;
    expect(text?.text).toBe('The answer is 42.\nA small count is 123.\nA year is 2026.\nVersion 1.2.3 works.');
  });

  it('removes clustered standalone numbers only alongside other status artifacts', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-clustered' });
    await manager.start();

    getProcess().emit('notification', 'session/update', {
      sessionId: 'sess-clustered',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'content',
          content: {
            type: 'text',
            text: 'Before\n321:46\n31\n42\n30394\nAfter',
          },
        },
      },
    });

    const message = events.find((e) => e.update.sessionUpdate === 'agent_message_chunk');
    const text = ((message?.update as Record<string, unknown>)?.content as Record<string, unknown> | undefined)?.content as
      | Record<string, unknown>
      | undefined;
    expect(text?.text).toBe('Before\nAfter');
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
