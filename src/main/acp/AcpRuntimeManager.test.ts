import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { AcpRuntimeManager } from './AcpRuntimeManager';
import { getProviderConfig } from './providerConfigs';
import { startAgentSession, endAgentSession } from '../agentSessionLifecycle';
import type { AcpEventPayload } from '../../shared/acpTypes';
import type { AcpProcessOptions } from './AcpProcess';

interface MockAcpProcess {
  options: AcpProcessOptions;
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

vi.mock('../acp-api-client', () => ({
  acpApiGetAgentProfile: vi.fn().mockResolvedValue(null),
  acpApiGetUnreadMailCount: vi.fn().mockResolvedValue(0),
}));

vi.mock('../agentSessionLifecycle', () => ({
  startAgentSession: vi.fn().mockResolvedValue({ ok: true, session: { id: 'sess-1', sessionToken: 'tok', agentId: 123 } }),
  endAgentSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../agentSessionLifecycle', () => ({
  startAgentSession: vi.fn().mockResolvedValue({ ok: true, session: { id: 'sess-1', sessionToken: 'tok', agentId: 123 } }),
  endAgentSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./AcpProcess', () => ({
  AcpProcess: class extends EventEmitter {
    options: AcpProcessOptions;
    started = false;
    requests: Array<{ method: string; params: unknown }> = [];
    notifications: Array<{ method: string; params: unknown }> = [];
    responses: Array<{ id: number | string; result: unknown }> = [];
    killed = false;

    constructor(options: AcpProcessOptions) {
      super();
      this.options = options;
      mockState.lastInstance = this as unknown as MockAcpProcess;
    }

    start(): void {
      this.started = true;
    }

    async request(method: string, params?: unknown): Promise<unknown> {
      this.requests.push({ method, params });
      const response = mockState.responses.get(method);
      if (response instanceof Error) throw response;
      // Returning a Promise lets tests simulate in-flight streaming requests.
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

  it('spawns the Kimi ACP command with --yolo', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-cmd' });

    await manager.start();

    expect(getProcess().options).toMatchObject({
      command: 'kimi',
      args: ['--yolo', 'acp'],
      cwd: '/repo',
    });
  });

  it('sends the boot prompt after initialization when provided', async () => {
    const bootPrompt = 'You are NextPert. Mission: fix renderer blockers.';
    manager = new AcpRuntimeManager('rt-boot', getProviderConfig('kimi'), {
      agentName: 'NextPert',
      workDir: '/repo',
      projectId: 42,
      bootPrompt,
    });
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-boot' });

    await manager.start();

    expect(getProcess().requests).toContainEqual(
      expect.objectContaining({
        method: 'session/prompt',
        params: expect.objectContaining({
          sessionId: 'sess-boot',
          prompt: [{ type: 'text', text: bootPrompt }],
        }),
      }),
    );
  });

  it('synthesizes a code-generated onboarding prompt when no boot prompt is provided', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-report' });

    await manager.start();

    const promptRequest = getProcess().requests.find(
      (r) => r.method === 'session/prompt' && r.params && (r.params as any).sessionId === 'sess-report',
    );
    expect(promptRequest).toBeDefined();
    const text = ((promptRequest?.params as any).prompt as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toBe('report as NextPert');
    expect(text).toContain('NextPert');
    expect(text).toContain('Load Identity');
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

  it('emits turn_complete when session/prompt resolves with stopReason', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-complete' });
    await manager.start();

    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    await manager.prompt('hello');

    const complete = events.find((e) => e.update.sessionUpdate === 'turn_complete');
    expect(complete).toBeDefined();
    expect(complete?.update).toMatchObject({
      sessionUpdate: 'turn_complete',
      sessionId: 'sess-complete',
      stopReason: 'end_turn',
    });
  });

  it('injects mail notices when the user has not recently spoken', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-mail' });
    await manager.start();

    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    const injected = await manager.injectMail('you have mail');

    expect(injected).toBe(true);
    expect(getProcess().requests).toContainEqual(
      expect.objectContaining({
        method: 'session/prompt',
        params: expect.objectContaining({
          sessionId: 'sess-mail',
          prompt: [{ type: 'text', text: 'you have mail' }],
        }),
      }),
    );
  });

  it('queues mail notices while a prompt is in flight', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-mail-cooldown' });
    await manager.start();

    // Hold the first user prompt open so mail gets queued against it.
    let deferredResolve: (value: unknown) => void = () => {};
    const deferredPromise = new Promise<unknown>((resolve) => {
      deferredResolve = resolve;
    });
    mockState.setResponse('session/prompt', deferredPromise);
    const userPrompt = manager.prompt('hello');
    await Promise.resolve();

    // Mail that arrives while the prompt is in flight should be queued.
    const mailPromise = manager.injectMail('you have mail');
    await Promise.resolve();

    const process = getProcess();
    // Boot prompt + first user prompt have been dispatched; mail is still queued.
    expect(process.requests.filter((r) => r.method === 'session/prompt').length).toBe(2);

    // Complete the first prompt; the queued mail should then be sent.
    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    deferredResolve({ stopReason: 'end_turn' });
    await userPrompt;
    await mailPromise;

    const promptRequests = process.requests.filter((r) => r.method === 'session/prompt');
    expect(promptRequests.length).toBe(3);
    expect((promptRequests[1].params as any).prompt[0].text).toBe('hello');
    expect((promptRequests[2].params as any).prompt[0].text).toBe('you have mail');
  });

  it('serializes concurrent prompts so only one session/prompt is in flight at a time', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-serial' });
    await manager.start();

    let deferredResolve: (value: unknown) => void = () => {};
    const deferredPromise = new Promise<unknown>((resolve) => {
      deferredResolve = resolve;
    });
    // Hold the first user prompt open so we can queue a second one against it.
    mockState.setResponse('session/prompt', deferredPromise);

    await manager.prompt('first');
    await Promise.resolve();

    const process = getProcess();
    // Boot prompt + first user prompt have both been dispatched.
    expect(process.requests.filter((r) => r.method === 'session/prompt').length).toBe(2);

    // Queue a second prompt while the first is still in flight.
    const secondDispatched = manager.prompt('second');
    await Promise.resolve();
    // No new request should have been issued while the first is pending.
    expect(process.requests.filter((r) => r.method === 'session/prompt').length).toBe(2);

    // Complete the first prompt; the second should then be sent.
    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    deferredResolve({ stopReason: 'end_turn' });
    await secondDispatched;

    const promptRequests = process.requests.filter((r) => r.method === 'session/prompt');
    expect(promptRequests.length).toBe(3);
    expect((promptRequests[1].params as any).prompt[0].text).toBe('first');
    expect((promptRequests[2].params as any).prompt[0].text).toBe('second');

    const completes = events.filter((e) => e.update.sessionUpdate === 'turn_complete');
    expect(completes.length).toBeGreaterThanOrEqual(2);
  });

  it('emits turn_complete with default stopReason when session/prompt resolves without one', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-no-stop' });
    await manager.start();

    mockState.setResponse('session/prompt', {});
    await manager.prompt('hello');

    const complete = events.find((e) => e.update.sessionUpdate === 'turn_complete');
    expect(complete).toBeDefined();
    expect(complete?.update).toMatchObject({
      sessionUpdate: 'turn_complete',
      sessionId: 'sess-no-stop',
      stopReason: 'end_turn',
    });
  });

  it('emits an error event when session/prompt hangs (image-paste Answering spinner bug)', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-hang' });
    await manager.start();

    vi.useFakeTimers();
    // Prevent the automatic restart from leaving fake timers behind in this test.
    const restartSpy = vi.spyOn(manager as unknown as { restart: () => Promise<void> }, 'restart').mockResolvedValue(undefined);
    // Simulate a runtime that streams content but never returns a session/prompt result.
    mockState.setResponse('session/prompt', new Promise<unknown>(() => {}));
    manager.prompt('hello');

    await vi.advanceTimersByTimeAsync(300_001);

    const error = events.find((e) => e.update.sessionUpdate === 'error');
    expect(error).toBeDefined();
    expect(error?.update).toMatchObject({
      sessionUpdate: 'error',
      sessionId: 'sess-hang',
      error: expect.stringContaining('No response'),
    });
    expect(restartSpy).toHaveBeenCalled();

    restartSpy.mockRestore();
    manager.kill();
    vi.useRealTimers();
  });

  it('completes a turn that stays active past 10 minutes with the same session', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-long' });
    await manager.start();

    vi.useFakeTimers();
    const restartSpy = vi.spyOn(manager as unknown as { restart: () => Promise<void> }, 'restart');
    const process = getProcess();

    let resolveTurn: (value: unknown) => void = () => {};
    mockState.setResponse('session/prompt', new Promise<unknown>((resolve) => { resolveTurn = resolve; }));
    manager.prompt('long healthy turn');

    // 11 minutes of steady content-bearing output: each chunk resets the idle
    // watchdog, and no wall-clock ceiling may fire. Total advanced: 660_000ms.
    for (let i = 0; i < 11; i++) {
      process.emit('notification', 'session/update', {
        sessionId: 'sess-long',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'content', content: { type: 'text', text: `chunk ${i}` } },
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);
    }

    resolveTurn({ stopReason: 'max_tokens' });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(manager.getSessionId()).toBe('sess-long');
    expect(getProcess()).toBe(process);
    expect(restartSpy).not.toHaveBeenCalled();
    expect(events.find((e) => e.update.sessionUpdate === 'error')).toBeUndefined();
    expect(
      events.some(
        (e) => e.update.sessionUpdate === 'turn_complete'
          && e.update.sessionId === 'sess-long'
          && (e.update as Record<string, unknown>).stopReason === 'max_tokens',
      ),
    ).toBe(true);

    restartSpy.mockRestore();
    manager.kill();
    vi.useRealTimers();
  });

  it('cancels the turn, keeps the session, and drains the queue when a prompt fails with a live process', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-fail' });
    await manager.start();

    const process = getProcess();
    const restartSpy = vi.spyOn(manager as unknown as { restart: () => Promise<void> }, 'restart');

    let rejectTurn: (err: Error) => void = () => {};
    mockState.setResponse('session/prompt', new Promise<unknown>((_, reject) => { rejectTurn = reject; }));
    await manager.prompt('first');
    const secondDispatched = manager.prompt('second');
    await Promise.resolve();
    // Boot prompt + first user prompt dispatched; second is queued in flight.
    expect(process.requests.filter((r) => r.method === 'session/prompt').length).toBe(2);

    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    rejectTurn(new Error('boom'));
    await secondDispatched;
    await new Promise((resolve) => setImmediate(resolve));

    expect(process.notifications).toContainEqual(
      expect.objectContaining({
        method: 'session/cancel',
        params: expect.objectContaining({ sessionId: 'sess-fail' }),
      }),
    );
    const error = events.find((e) => e.update.sessionUpdate === 'error');
    expect(error?.update).toMatchObject({
      sessionId: 'sess-fail',
      error: expect.stringContaining('boom'),
    });
    expect(
      events.some(
        (e) => e.update.sessionUpdate === 'turn_complete'
          && (e.update as Record<string, unknown>).stopReason === 'cancel',
      ),
    ).toBe(true);
    expect(manager.getSessionId()).toBe('sess-fail');
    expect(getProcess()).toBe(process);
    expect(restartSpy).not.toHaveBeenCalled();

    const promptRequests = process.requests.filter((r) => r.method === 'session/prompt');
    expect(promptRequests.length).toBe(3);
    expect((promptRequests[2].params as any).prompt[0].text).toBe('second');

    restartSpy.mockRestore();
    manager.kill();
  });

  it('restarts a hung runtime that streams only non-content notifications', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-noise' });
    await manager.start();

    vi.useFakeTimers();
    const restartSpy = vi.spyOn(manager as unknown as { restart: () => Promise<void> }, 'restart').mockResolvedValue(undefined);
    mockState.setResponse('session/prompt', new Promise<unknown>(() => {}));
    manager.prompt('hello');

    // Non-content updates (lifecycle chatter) must NOT reset the idle watchdog:
    // 25 x 15s = 375s of noise still trips the 300s idle budget.
    for (let i = 0; i < 25; i++) {
      getProcess().emit('notification', 'session/update', {
        sessionId: 'sess-noise',
        update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
      });
      await vi.advanceTimersByTimeAsync(15_000);
    }

    const error = events.find((e) => e.update.sessionUpdate === 'error');
    expect(error?.update).toMatchObject({
      sessionUpdate: 'error',
      sessionId: 'sess-noise',
      error: expect.stringContaining('No response'),
    });
    expect(restartSpy).toHaveBeenCalled();

    restartSpy.mockRestore();
    manager.kill();
    vi.useRealTimers();
  });

  it('preserves recent user prompts in boot prompt after restart', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-restart-context' });
    await manager.start();

    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    await manager.prompt('mission alpha');

    // Restart should create a new process and re-send a boot prompt that
    // includes the preserved user prompt so context is not lost.
    await manager.restart();

    const bootRequests = getProcess().requests.filter(
      (r) => r.method === 'session/prompt' && typeof (r.params as any).prompt[0].text === 'string',
    );
    const latestBootPrompt = bootRequests[bootRequests.length - 1]?.params as { prompt: Array<{ text: string }> };
    expect(latestBootPrompt).toBeDefined();
    expect(latestBootPrompt.prompt[0].text).toContain('mission alpha');
    expect(latestBootPrompt.prompt[0].text).toContain('Restart context');
  });

  it('forwards structured content blocks when runtime declares image support', async () => {
    mockState.setResponse('initialize', {
      agentCapabilities: { promptCapabilities: { image: true } },
      agentInfo: { name: 'Kimi' },
    });
    mockState.setResponse('session/new', { sessionId: 'sess-img' });
    await manager.start();

    await manager.sendMessage([
      { type: 'text', text: 'what is this?' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);

    expect(getProcess().requests).toContainEqual(
      expect.objectContaining({
        method: 'session/prompt',
        params: expect.objectContaining({
          sessionId: 'sess-img',
          prompt: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          ],
        }),
      }),
    );
  });

  it('builds markdown data-URI fallback when runtime does not declare image support', async () => {
    mockState.setResponse('initialize', {
      agentCapabilities: { promptCapabilities: {} },
      agentInfo: { name: 'Kimi' },
    });
    mockState.setResponse('session/new', { sessionId: 'sess-fallback' });
    await manager.start();

    await manager.sendMessage([
      { type: 'text', text: 'explain this error' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);

    const promptRequests = getProcess().requests.filter((r) => r.method === 'session/prompt');
    expect(promptRequests.length).toBeGreaterThanOrEqual(1);
    const promptRequest = promptRequests[promptRequests.length - 1];
    const prompt = ((promptRequest?.params as any).prompt as Array<{ type: string; text?: string }>);
    expect(prompt).toHaveLength(1);
    expect(prompt[0].type).toBe('text');
    expect(prompt[0].text).toContain('[Image pasted into chat context]');
    expect(prompt[0].text).toContain('explain this error');
    expect(prompt[0].text).toContain('data:image/png;base64,aGVsbG8=');
  });

  it('falls back to plain text when no images are present and image support is missing', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-text' });
    await manager.start();

    await manager.sendMessage([{ type: 'text', text: 'just text' }]);

    expect(getProcess().requests).toContainEqual(
      expect.objectContaining({
        method: 'session/prompt',
        params: expect.objectContaining({
          sessionId: 'sess-text',
          prompt: [{ type: 'text', text: 'just text' }],
        }),
      }),
    );
  });

  it('throws when sending a message before initialization', async () => {
    await expect(
      manager.sendMessage([{ type: 'text', text: 'too early' }]),
    ).rejects.toThrow('ACP runtime not initialized');
  });

  it('cancels the active turn and emits turn_complete', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-4' });
    await manager.start();

    manager.cancel();

    expect(getProcess().notifications).toContainEqual(
      expect.objectContaining({ method: 'session/cancel' }),
    );
    const complete = events.filter((e) => e.update.sessionUpdate === 'turn_complete').pop();
    expect(complete).toBeDefined();
    expect(complete?.update).toMatchObject({
      sessionUpdate: 'turn_complete',
      sessionId: 'sess-4',
      stopReason: 'cancel',
    });
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
    manager.setAutoApprove(false);

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
  }, 15000);

  it('kills the underlying process', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-8' });
    await manager.start();

    manager.kill();
    expect(getProcess().killed).toBe(true);
  });

  it('starts a PayEzVibe session when agentId is provided', async () => {
    manager = new AcpRuntimeManager('rt-vibe', getProviderConfig('kimi'), {
      agentName: 'NextPert',
      workDir: '/repo',
      projectId: 42,
      agentId: 123,
    });
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-vibe' });

    await manager.start();

    expect(startAgentSession).toHaveBeenCalledWith('rt-vibe', 123, 42);
  });

  it('ends the PayEzVibe session on kill', async () => {
    manager = new AcpRuntimeManager('rt-vibe-end', getProviderConfig('kimi'), {
      agentName: 'NextPert',
      workDir: '/repo',
      projectId: 42,
      agentId: 456,
    });
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-vibe-end' });
    await manager.start();
    vi.mocked(endAgentSession).mockClear();

    manager.kill();

    expect(endAgentSession).toHaveBeenCalledWith('rt-vibe-end', 'normal');
  });
});
