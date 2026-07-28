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

// In-memory stand-in for the electron-store settings module. AcpRuntimeManager
// reads/writes `acpSessionIds` for crash-safe session resume; tests must not
// touch the real user settings file.
const mockSettings = vi.hoisted(() => ({
  data: { acpSessionIds: {} as Record<string, string> },
}));

vi.mock('../store', () => ({
  getSettings: vi.fn(() => ({ acpSessionIds: mockSettings.data.acpSessionIds })),
  setSettings: vi.fn((patch: Record<string, unknown>) => {
    if ('acpSessionIds' in patch) {
      mockSettings.data.acpSessionIds = patch.acpSessionIds as Record<string, string>;
    }
  }),
}));

describe('AcpRuntimeManager', () => {
  let manager: AcpRuntimeManager;
  let events: AcpEventPayload[] = [];

  beforeEach(() => {
    mockState.responses.clear();
    mockState.lastInstance = null;
    mockSettings.data.acpSessionIds = {};
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

  it('appends image blocks after the text block in the same session/prompt', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-img' });
    await manager.start();

    await manager.prompt('look at these', [
      { data: 'QUJD', mimeType: 'image/png', name: 'one.png' },
      { data: 'REVG', mimeType: 'image/png', name: 'two.png' },
    ]);

    expect(getProcess().requests).toContainEqual(
      expect.objectContaining({
        method: 'session/prompt',
        params: expect.objectContaining({
          sessionId: 'sess-img',
          prompt: [
            { type: 'text', text: 'look at these' },
            { type: 'image', data: 'QUJD', mimeType: 'image/png' },
            { type: 'image', data: 'REVG', mimeType: 'image/png' },
          ],
        }),
      }),
    );
  });

  it('keeps prompt() text-only when no images are passed', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-text-only' });
    await manager.start();

    await manager.prompt('just text', []);

    expect(getProcess().requests).toContainEqual(
      expect.objectContaining({
        method: 'session/prompt',
        params: expect.objectContaining({
          sessionId: 'sess-text-only',
          prompt: [{ type: 'text', text: 'just text' }],
        }),
      }),
    );
  });

  it('fails loud when the spawned kimi is below the 0.23.5 version floor', async () => {
    mockState.setResponse('initialize', {
      agentCapabilities: {},
      agentInfo: { name: 'Kimi Code CLI', version: '0.20.0' },
    });
    mockState.setResponse('session/new', { sessionId: 'sess-old' });

    await expect(manager.start()).rejects.toThrow(/kimi >= 0\.23\.5 required/);

    expect(manager.isInitialized()).toBe(false);
    const errorEvent = events.find((e) => e.update.sessionUpdate === 'error');
    expect(errorEvent?.update).toMatchObject({
      sessionUpdate: 'error',
      error: expect.stringContaining('0.23.5'),
    });
    // The runtime must fail before establishing a session.
    expect(getProcess().requests.some((r) => r.method === 'session/new')).toBe(false);
  });

  it('accepts a kimi version exactly at the 0.23.5 floor', async () => {
    mockState.setResponse('initialize', {
      agentCapabilities: {},
      agentInfo: { name: 'Kimi Code CLI', version: '0.23.5' },
    });
    mockState.setResponse('session/new', { sessionId: 'sess-floor' });

    await manager.start();

    expect(manager.isInitialized()).toBe(true);
  });

  it('accepts a kimi version above the floor', async () => {
    mockState.setResponse('initialize', {
      agentCapabilities: {},
      agentInfo: { name: 'Kimi Code CLI', version: '0.27.0' },
    });
    mockState.setResponse('session/new', { sessionId: 'sess-new' });

    await manager.start();

    expect(manager.isInitialized()).toBe(true);
  });

  it('warns and proceeds when agentInfo.version is absent or unparseable', async () => {
    mockState.setResponse('initialize', {
      agentCapabilities: {},
      agentInfo: { name: 'Kimi Code CLI', version: '1.0' },
    });
    mockState.setResponse('session/new', { sessionId: 'sess-unparseable' });

    await manager.start();

    expect(manager.isInitialized()).toBe(true);
  });

  it('surfaces the active model imageIn capability from session configOptions', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', {
      sessionId: 'sess-imagein',
      configOptions: [
        {
          type: 'select',
          id: 'model',
          currentValue: 'kimi-for-coding',
          options: [
            { value: 'k2', name: 'K2', imageIn: true },
            { value: 'kimi-for-coding', name: 'Kimi For Coding', imageIn: false },
          ],
        },
      ],
    });

    await manager.start();

    const initialized = events.find((e) => e.update.sessionUpdate === 'initialized');
    expect(initialized?.update).toMatchObject({
      sessionUpdate: 'initialized',
      sessionId: 'sess-imagein',
      imageIn: false,
    });
  });

  it('leaves imageIn unknown when configOptions is absent (older runtimes)', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-no-config' });

    await manager.start();

    const initialized = events.find((e) => e.update.sessionUpdate === 'initialized');
    expect(initialized?.update).toMatchObject({
      sessionUpdate: 'initialized',
      sessionId: 'sess-no-config',
    });
    expect(
      initialized?.update.sessionUpdate === 'initialized' && initialized.update.imageIn,
    ).toBeUndefined();
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

  it('defers a mail inject instead of queueing when the runtime busy-rejects (mail never stacks, WO 11622)', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-mail-defer' });
    await manager.start();

    let deferredResolve: (value: unknown) => void = () => {};
    const deferredPromise = new Promise<unknown>((resolve) => {
      deferredResolve = resolve;
    });
    mockState.setResponse('session/prompt', deferredPromise);
    const userPrompt = manager.prompt('hello');
    await Promise.resolve();

    // The runtime busy-rejects the steer: mail DEFERS (no queue, no stacked
    // turn) — it will be picked up by the catch-up synthesis at idle.
    mockState.setResponse(
      'session/prompt',
      new Error('Cannot launch a new turn while another turn (ID 1) is active'),
    );
    const mailPromise = manager.injectMail('you have mail');
    await Promise.resolve();
    await Promise.resolve();

    await expect(mailPromise).resolves.toBe(false);
    const process = getProcess();
    // Boot + user + the rejected steer attempt — and nothing more, ever.
    expect(process.requests.filter((r) => r.method === 'session/prompt').length).toBe(3);
    expect(events.some((e) => e.update.sessionUpdate === 'prompt_queued')).toBe(false);

    // After the turn ends, the deferred mail is NOT re-dispatched.
    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    deferredResolve({ stopReason: 'end_turn' });
    await userPrompt;
    await new Promise((r) => setImmediate(r));
    expect(process.requests.filter((r) => r.method === 'session/prompt').length).toBe(3);

    manager.kill();
  });

  it('migrates pendingSteers into the queue on restart-resume without a false settle from the old process (WO 11652)', async () => {
    mockState.setResponse('initialize', { agentCapabilities: { loadSession: true } });
    mockState.setResponse('session/resume', { sessionId: 'sess-steer-resume' });
    mockState.setResponse('session/new', { sessionId: 'sess-steer-new' });
    await manager.start();

    // In-flight user turn (never settles) → mail steers through and pends.
    mockState.setResponse('session/prompt', new Promise<unknown>(() => {}));
    await manager.prompt('in-flight');
    const mailPromise = manager.injectMail('you have mail');
    await Promise.resolve();

    // Restart: the resume succeeds, so the pending steer migrates into the
    // queue and drains — it must resolve TRUE via dispatch, never false-settle
    // from the old process's rejected steer request.
    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    await manager.restart();

    await expect(mailPromise).resolves.toBe(true);
    const mailDispatches = getProcess().requests.filter(
      (r) =>
        r.method === 'session/prompt' &&
        (r.params as { prompt: Array<{ text: string }> }).prompt[0].text === 'you have mail',
    );
    expect(mailDispatches.length).toBeGreaterThan(0);

    manager.kill();
  });

  it('steers mail notices through while a prompt is in flight (slice B)', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-mail-cooldown' });
    await manager.start();

    // Hold the first user prompt open so mail arrives mid-turn.
    let deferredResolve: (value: unknown) => void = () => {};
    const deferredPromise = new Promise<unknown>((resolve) => {
      deferredResolve = resolve;
    });
    mockState.setResponse('session/prompt', deferredPromise);
    const userPrompt = manager.prompt('hello');
    await Promise.resolve();

    // Mail that arrives while the prompt is in flight is STEERED through
    // immediately — never manager-queued.
    const mailPromise = manager.injectMail('you have mail');
    await Promise.resolve();

    const process = getProcess();
    expect(process.requests.filter((r) => r.method === 'session/prompt').length).toBe(3);
    expect(events.some((e) => e.update.sessionUpdate === 'prompt_queued')).toBe(false);

    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    deferredResolve({ stopReason: 'end_turn' });
    await userPrompt;
    await expect(mailPromise).resolves.toBe(true);

    const promptRequests = process.requests.filter((r) => r.method === 'session/prompt');
    expect((promptRequests[2].params as any).prompt[0].text).toBe('you have mail');
  });

  it('falls back to queueing when the runtime busy-rejects a steer (slice B backstop)', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-serial' });
    await manager.start();

    let deferredResolve: (value: unknown) => void = () => {};
    const deferredPromise = new Promise<unknown>((resolve) => {
      deferredResolve = resolve;
    });
    // Hold the first user prompt open so the steer attempt happens mid-turn.
    mockState.setResponse('session/prompt', deferredPromise);

    await manager.prompt('first');
    await Promise.resolve();

    const process = getProcess();
    // Boot prompt + first user prompt have both been dispatched.
    expect(process.requests.filter((r) => r.method === 'session/prompt').length).toBe(2);

    // The runtime busy-rejects the steer (it predates the adapter steer):
    // the manager falls back to queue + drain — the ONLY prompt_queued path.
    mockState.setResponse(
      'session/prompt',
      new Error('Cannot launch a new turn while another turn (ID 1) is active'),
    );
    const secondDispatched = manager.prompt('second');
    await Promise.resolve();
    await Promise.resolve();

    // The runtime busy-rejects the steer attempt: the prompt takes the
    // backstop queue path (request #3 IS the rejected steer attempt).
    expect(events.some((e) => e.update.sessionUpdate === 'prompt_queued')).toBe(true);
    expect(process.requests.filter((r) => r.method === 'session/prompt').length).toBe(3);

    // The turn ends; the queued prompt drains as request #4.
    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    deferredResolve({ stopReason: 'end_turn' });
    await secondDispatched;

    const promptRequests = process.requests.filter((r) => r.method === 'session/prompt');
    expect(promptRequests.length).toBe(4);
    expect((promptRequests[1].params as any).prompt[0].text).toBe('first');
    expect((promptRequests[3].params as any).prompt[0].text).toBe('second');

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
    // Force the steer attempt to busy-reject so 'second' takes the queue path.
    mockState.setResponse(
      'session/prompt',
      new Error('Cannot launch a new turn while another turn (ID 1) is active'),
    );
    const secondDispatched = manager.prompt('second');
    await Promise.resolve();
    await Promise.resolve();
    // Boot prompt + first user prompt dispatched; the steer attempt
    // busy-rejected and the prompt queued (request #3 is the failed attempt).
    expect(events.some((e) => e.update.sessionUpdate === 'prompt_queued')).toBe(true);

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
          && (e.update as Record<string, unknown>).stopReason === 'cancelled',
      ),
    ).toBe(true);
    expect(manager.getSessionId()).toBe('sess-fail');
    expect(getProcess()).toBe(process);
    expect(restartSpy).not.toHaveBeenCalled();

    const promptRequests = process.requests.filter((r) => r.method === 'session/prompt');
    expect(promptRequests.length).toBe(4);
    expect((promptRequests[3].params as any).prompt[0].text).toBe('second');

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

  it('treats wait_state updates as meaningful activity and forwards them to the renderer', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-wait' });
    await manager.start();

    vi.useFakeTimers();
    const restartSpy = vi.spyOn(manager as unknown as { restart: () => Promise<void> }, 'restart');
    const process = getProcess();

    let resolveTurn: (value: unknown) => void = () => {};
    mockState.setResponse('session/prompt', new Promise<unknown>((resolve) => { resolveTurn = resolve; }));
    manager.prompt('slow provider');

    // 7 minutes of provider retry backoff reported as wait_state frames
    // (420s > the 300s idle budget): each frame is meaningful activity, so
    // the watchdog must not fire while the runtime is reporting its waits.
    for (let i = 0; i < 7; i++) {
      process.emit('notification', 'session/update', {
        sessionId: 'sess-wait',
        update: {
          sessionUpdate: 'wait_state',
          kind: 'provider_retry',
          failedAttempt: i + 1,
          nextAttempt: i + 2,
          maxAttempts: 10,
          delayMs: 12_000,
          errorName: 'APITimeoutError',
          statusCode: 408,
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);
    }

    resolveTurn({ stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(restartSpy).not.toHaveBeenCalled();
    expect(events.find((e) => e.update.sessionUpdate === 'error')).toBeUndefined();
    const waitEvents = events.filter((e) => e.update.sessionUpdate === 'wait_state');
    expect(waitEvents).toHaveLength(7);
    expect(waitEvents[3]?.update).toMatchObject({
      sessionUpdate: 'wait_state',
      sessionId: 'sess-wait',
      waitState: {
        kind: 'provider_retry',
        failedAttempt: 4,
        nextAttempt: 5,
        maxAttempts: 10,
        delayMs: 12_000,
        errorName: 'APITimeoutError',
        statusCode: 408,
      },
    });

    restartSpy.mockRestore();
    manager.kill();
    vi.useRealTimers();
  });

  it('forwards awaiting_first_token wait_state and drops malformed frames', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-ws-first-token' });
    await manager.start();

    const process = getProcess();
    process.emit('notification', 'session/update', {
      sessionId: 'sess-ws-first-token',
      update: { sessionUpdate: 'wait_state', kind: 'awaiting_first_token' },
    });
    // Missing kind: malformed — must not reach the renderer.
    process.emit('notification', 'session/update', {
      sessionId: 'sess-ws-first-token',
      update: { sessionUpdate: 'wait_state', delayMs: 500 },
    });

    const waitEvents = events.filter((e) => e.update.sessionUpdate === 'wait_state');
    expect(waitEvents).toHaveLength(1);
    expect(waitEvents[0]?.update).toMatchObject({
      sessionUpdate: 'wait_state',
      sessionId: 'sess-ws-first-token',
      waitState: { kind: 'awaiting_first_token' },
    });

    manager.kill();
  });

  it('does not let a malformed wait_state frame reset the idle watchdog (WO 11498)', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-ws-malformed' });
    await manager.start();

    vi.useFakeTimers();
    const restartSpy = vi.spyOn(manager as unknown as { restart: () => Promise<void> }, 'restart');
    const process = getProcess();
    mockState.setResponse('session/prompt', new Promise<unknown>(() => {})); // never resolves
    await manager.prompt('slow provider');

    // 250s of silence, then a malformed wait_state frame (no kind — dropped
    // from the UI). If it fed the idle budget, the watchdog would fire at
    // ~550s instead of 300s.
    await vi.advanceTimersByTimeAsync(250_000);
    process.emit('notification', 'session/update', {
      sessionId: 'sess-ws-malformed',
      update: { sessionUpdate: 'wait_state', delayMs: 500 },
    });

    // 100s more: the 300s watchdog, measured from the last MEANINGFUL activity
    // (the prompt, not the malformed frame), must have tripped.
    await vi.advanceTimersByTimeAsync(100_000);

    expect(restartSpy).toHaveBeenCalled();

    restartSpy.mockRestore();
    manager.kill();
    vi.useRealTimers();
  });

  it('re-syncs and retries dispatch on turn.agent_busy without cancelling or failing the prompt', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-busy-resync' });
    await manager.start();
    events = []; // drop boot-prompt artifacts

    vi.useFakeTimers();
    const restartSpy = vi.spyOn(manager as unknown as { restart: () => Promise<void> }, 'restart');
    const process = getProcess();

    // First dispatch rejected: the runtime still runs a turn we believed over.
    mockState.setResponse(
      'session/prompt',
      new Error('Cannot launch a new turn while another turn (ID 20) is active (code -32600)'),
    );
    await manager.prompt('mission bravo');
    await vi.advanceTimersByTimeAsync(0); // let the rejection settle

    // No cancel, no surfaced failure, no restart — the prompt waits instead.
    expect(process.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(0);
    expect(events.find((e) => e.update.sessionUpdate === 'error')).toBeUndefined();
    expect(events.find((e) => e.update.sessionUpdate === 'turn_complete')).toBeUndefined();
    expect(restartSpy).not.toHaveBeenCalled();

    // The zombie turn ends — the runtime accepts the retried dispatch.
    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(5_000);

    const promptTexts = process.requests
      .filter((r) => r.method === 'session/prompt')
      .map((r) => (r.params as { prompt: Array<{ text: string }> }).prompt[0].text);
    expect(promptTexts.filter((t) => t === 'mission bravo')).toHaveLength(2);
    expect(
      events.some(
        (e) => e.update.sessionUpdate === 'turn_complete'
          && (e.update as Record<string, unknown>).stopReason === 'end_turn',
      ),
    ).toBe(true);
    expect(restartSpy).not.toHaveBeenCalled();

    restartSpy.mockRestore();
    manager.kill();
    vi.useRealTimers();
  });

  it('dispatches queued prompts in order after the busy turn ends (no cascade)', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-busy-order' });
    await manager.start();
    events = [];

    vi.useFakeTimers();
    const process = getProcess();

    mockState.setResponse('session/prompt', new Error('turn.agent_busy (code -32600)'));
    await manager.prompt('first');
    const secondDispatched = manager.prompt('second');
    await vi.advanceTimersByTimeAsync(0);

    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(5_000); // retry re-dispatches 'first'
    await expect(secondDispatched).resolves.toBeUndefined(); // 'second' drains next
    await vi.advanceTimersByTimeAsync(0);

    const promptTexts = process.requests
      .filter((r) => r.method === 'session/prompt')
      .map((r) => (r.params as { prompt: Array<{ text: string }> }).prompt[0].text);
    expect(promptTexts.filter((t) => t === 'first')).toHaveLength(2);
    // One failed steer attempt plus the drained dispatch for 'second'.
    expect(promptTexts.filter((t) => t === 'second')).toHaveLength(2);
    expect(promptTexts.lastIndexOf('second')).toBeGreaterThan(promptTexts.lastIndexOf('first'));
    expect(events.find((e) => e.update.sessionUpdate === 'error')).toBeUndefined();

    manager.kill();
    vi.useRealTimers();
  });

  it('trips the idle watchdog mid-busy-episode and restarts with session/new (skip resume once)', async () => {
    mockState.setResponse('initialize', { agentCapabilities: { loadSession: true } });
    mockState.setResponse('session/new', { sessionId: 'sess-busy-wedged' });
    await manager.start();
    events = [];

    vi.useFakeTimers();
    const process = getProcess();

    // The first dispatch busy-rejects; the re-sync probe then hangs forever —
    // the runtime never answers again (wedged busy turn). With only ONE
    // rejection the busy-cap escalation never fires; the watchdog is the
    // backstop that ends the episode.
    mockState.setResponse('session/prompt', new Error('turn.agent_busy (code -32600)'));
    await manager.prompt('stuck');
    await vi.advanceTimersByTimeAsync(0);
    mockState.setResponse('session/prompt', new Promise<unknown>(() => {}));

    // 19 ticks (285s): the in-flight retry probe must not reset the idle
    // clock, and no escalation may fire (one rejection only).
    for (let i = 0; i < 19; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(process.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(0);
    expect(events.find((e) => e.update.sessionUpdate === 'error')).toBeUndefined();

    // Past 300s of true silence, the watchdog trips: best-effort cancel +
    // failPendingTurn + restart, as today.
    await vi.advanceTimersByTimeAsync(30_000);
    const error = events.find((e) => e.update.sessionUpdate === 'error');
    expect(error?.update).toMatchObject({
      sessionUpdate: 'error',
      error: expect.stringContaining('No response'),
    });
    expect(process.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000); // restart's post-kill pause + start

    // A busy episode that consumed the whole idle budget is a property of the
    // resumed session: the restart falls back to session/new exactly once
    // instead of resuming (loadSession IS advertised and lastSessionId is
    // set — resume was skipped, not unavailable).
    const fresh = getProcess();
    expect(fresh).not.toBe(process);
    expect(fresh.requests.some((r) => r.method === 'session/new')).toBe(true);
    expect(fresh.requests.some((r) => r.method === 'session/resume')).toBe(false);

    manager.kill();
    vi.useRealTimers();
  });

  it('probes immediately when turn_complete arrives mid-busy-episode (no 5s wait)', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-busy-probe' });
    await manager.start();
    events = [];

    vi.useFakeTimers();
    const process = getProcess();

    mockState.setResponse('session/prompt', new Error('turn.agent_busy (code -32600)'));
    await manager.prompt('mission bravo');
    await vi.advanceTimersByTimeAsync(0); // rejection settles: re-queued, retry timer armed

    const promptCount = () => process.requests.filter((r) => r.method === 'session/prompt').length;
    expect(promptCount()).toBe(2); // boot + the rejected initial dispatch

    // The busy turn ends at t≈0, long before the 5s retry tick — the manager
    // must probe NOW.
    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    process.emit('notification', 'session/update', {
      sessionId: 'sess-busy-probe',
      update: { sessionUpdate: 'turn_complete', stopReason: 'end_turn' },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(promptCount()).toBe(3); // the immediate probe — no 5s wait
    expect(events.some((e) => e.update.sessionUpdate === 'prompt_dequeued')).toBe(true);
    expect(events.find((e) => e.update.sessionUpdate === 'error')).toBeUndefined();
    expect(
      events.some(
        (e) => e.update.sessionUpdate === 'turn_complete'
          && (e.update as Record<string, unknown>).stopReason === 'end_turn',
      ),
    ).toBe(true);

    // The canceled retry timer must not fire a second probe later.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(promptCount()).toBe(3);

    manager.kill();
    vi.useRealTimers();
  });

  it('does not probe on turn_complete when no busy retry is pending', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-idle-tc' });
    await manager.start();
    events = [];

    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    await manager.prompt('hello');

    const process = getProcess();
    const promptCount = () => process.requests.filter((r) => r.method === 'session/prompt').length;
    const before = promptCount();

    // An ordinary turn completion (no busy episode in progress) must not
    // cause any extra dispatch.
    process.emit('notification', 'session/update', {
      sessionId: 'sess-idle-tc',
      update: { sessionUpdate: 'turn_complete', stopReason: 'end_turn' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(promptCount()).toBe(before);

    manager.kill();
  });

  it('escalates after 12 consecutive busy rejections: cancel, failPendingTurn, fresh-session restart', async () => {
    mockState.setResponse('initialize', { agentCapabilities: { loadSession: true } });
    mockState.setResponse('session/new', { sessionId: 'sess-busy-cap' });
    await manager.start();
    events = [];

    vi.useFakeTimers();
    const process = getProcess();

    // Every dispatch busy-rejects: the initial dispatch plus 11 probes = 12
    // consecutive rejections (≈55s of probing), then the cap escalates.
    mockState.setResponse('session/prompt', new Error('turn.agent_busy (code -32600)'));
    await manager.prompt('stuck');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    // The fresh runtime accepts prompts again.
    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(10_000); // restart pause + fresh start + boot

    // Escalation took the watchdog path on the old process: exactly one
    // best-effort cancel, plus failPendingTurn's error + turn_complete.
    expect(process.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(1);
    expect(
      events.some(
        (e) => e.update.sessionUpdate === 'error'
          && typeof e.update.error === 'string'
          && e.update.error.includes('turn.agent_busy')
          && e.update.error.includes('fresh session'),
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.update.sessionUpdate === 'turn_complete'
          && (e.update as Record<string, unknown>).stopReason === 'cancelled',
      ),
    ).toBe(true);

    // The prompt was dispatched exactly 12 times (initial + 11 probes).
    const stuckDispatches = process.requests
      .filter((r) => r.method === 'session/prompt')
      .map((r) => (r.params as { prompt: Array<{ text: string }> }).prompt[0].text)
      .filter((t) => t === 'stuck');
    expect(stuckDispatches).toHaveLength(12);

    // The restart skipped resume once: session/new, NOT session/resume —
    // even though loadSession is advertised and lastSessionId is set.
    const fresh = getProcess();
    expect(fresh).not.toBe(process);
    expect(fresh.requests.some((r) => r.method === 'session/new')).toBe(true);
    expect(fresh.requests.some((r) => r.method === 'session/resume')).toBe(false);

    // The re-queued prompt settled via the existing fresh-session queue
    // handling: visible drop + queue_cleared (not silently lost).
    expect(
      events.some(
        (e) => e.update.sessionUpdate === 'error'
          && typeof e.update.error === 'string'
          && e.update.error.includes('runtime restarted with a fresh session'),
      ),
    ).toBe(true);
    expect(events.some((e) => e.update.sessionUpdate === 'queue_cleared')).toBe(true);

    manager.kill();
    vi.useRealTimers();
  });

  it('sends session/cancel once at the 3rd busy rejection; a freed session dispatches without restart', async () => {
    mockState.setResponse('initialize', { agentCapabilities: { loadSession: true } });
    mockState.setResponse('session/new', { sessionId: 'sess-busy-early-cancel' });
    await manager.start();
    events = [];

    vi.useFakeTimers();
    const process = getProcess();
    const cancels = () => process.notifications.filter((n) => n.method === 'session/cancel').length;

    mockState.setResponse('session/prompt', new Error('turn.agent_busy (code -32600)'));
    await manager.prompt('stuck');
    await vi.advanceTimersByTimeAsync(0); // rejection 1
    await vi.advanceTimersByTimeAsync(5_000); // rejection 2
    expect(cancels()).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000); // rejection 3 → early cancel fires
    expect(cancels()).toBe(1);

    // The cancel freed the zombie turn: the next probe dispatches cleanly.
    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(5_000);

    // No restart, no escalation, exactly one cancel for the whole episode.
    expect(getProcess()).toBe(process);
    expect(cancels()).toBe(1);
    expect(events.some((e) => e.update.sessionUpdate === 'error')).toBe(false);
    expect(
      events.some(
        (e) => e.update.sessionUpdate === 'turn_complete'
          && (e.update as Record<string, unknown>).stopReason === 'end_turn',
      ),
    ).toBe(true);

    // Episode state reset: a later busy episode must cancel early again.
    mockState.setResponse('session/prompt', new Error('turn.agent_busy (code -32600)'));
    await manager.prompt('stuck-again');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000); // rejection 3 of episode two
    expect(cancels()).toBe(2);

    manager.kill();
    vi.useRealTimers();
  });

  it('skips resume exactly once: the next restart resumes the new session again', async () => {
    mockState.setResponse('initialize', { agentCapabilities: { loadSession: true } });
    mockState.setResponse('session/new', { sessionId: 'sess-busy-once' });
    mockState.setResponse('session/resume', { sessionId: 'sess-busy-once' });
    await manager.start();
    events = [];

    vi.useFakeTimers();
    const process = getProcess();

    // Drive a full capped episode (12 rejections) → fresh-session restart.
    mockState.setResponse('session/prompt', new Error('turn.agent_busy (code -32600)'));
    await manager.prompt('stuck');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(10_000);

    const fresh = getProcess();
    expect(fresh).not.toBe(process);
    expect(fresh.requests.some((r) => r.method === 'session/new')).toBe(true);
    expect(fresh.requests.some((r) => r.method === 'session/resume')).toBe(false);

    // Exactly once: a later restart resumes the (new) session normally.
    vi.useRealTimers();
    await manager.restart();
    const third = getProcess();
    expect(third).not.toBe(fresh);
    expect(third.requests).toContainEqual(
      expect.objectContaining({
        method: 'session/resume',
        params: expect.objectContaining({ sessionId: 'sess-busy-once' }),
      }),
    );
    expect(third.requests.some((r) => r.method === 'session/new')).toBe(false);

    manager.kill();
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

  it('hydrates the persisted session id and resumes it on start', async () => {
    mockSettings.data.acpSessionIds = { 'NextPert::/repo': 'sess-persisted' };
    manager = new AcpRuntimeManager('rt-persist', getProviderConfig('kimi'), {
      agentName: 'NextPert',
      workDir: '/repo',
      projectId: 42,
    });
    manager.on('event', (payload: AcpEventPayload) => events.push(payload));
    mockState.setResponse('initialize', { agentCapabilities: { loadSession: true } });
    mockState.setResponse('session/resume', { sessionId: 'sess-persisted' });

    await manager.start();

    expect(getProcess().requests).toContainEqual(
      expect.objectContaining({
        method: 'session/resume',
        params: expect.objectContaining({ sessionId: 'sess-persisted' }),
      }),
    );
    expect(getProcess().requests.find((r) => r.method === 'session/new')).toBeUndefined();
    expect(manager.getSessionId()).toBe('sess-persisted');
    // App-launch resume: a lightweight wake-up nudge goes out so the agent
    // visibly comes online — but NOT the full boot prompt (the resumed
    // session already carries identity and history).
    const nudgeRequest = getProcess().requests.find((r) => r.method === 'session/prompt');
    expect(nudgeRequest).toBeDefined();
    const nudgeText = ((nudgeRequest?.params as any).prompt as Array<{ type: string; text: string }>)[0].text;
    expect(nudgeText).toContain('NextPert');
    expect(nudgeText).toContain('session resumed');
    expect(nudgeText).not.toContain('Load Identity');
  });

  it('does not re-nudge after an in-process restart of a resumed session', async () => {
    mockSettings.data.acpSessionIds = { 'NextPert::/repo': 'sess-persisted' };
    manager = new AcpRuntimeManager('rt-persist-restart', getProviderConfig('kimi'), {
      agentName: 'NextPert',
      workDir: '/repo',
      projectId: 42,
    });
    manager.on('event', (payload: AcpEventPayload) => events.push(payload));
    mockState.setResponse('initialize', { agentCapabilities: { loadSession: true } });
    mockState.setResponse('session/resume', { sessionId: 'sess-persisted' });
    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });

    await manager.start();
    // App-launch resume sent exactly one wake-up nudge.
    expect(getProcess().requests.filter((r) => r.method === 'session/prompt')).toHaveLength(1);

    await manager.restart();

    // In-process restart resumes again (new process), but stays silent: the
    // renderer still holds the transcript, so no nudge and no boot prompt.
    expect(getProcess().requests).toContainEqual(
      expect.objectContaining({ method: 'session/resume' }),
    );
    expect(getProcess().requests.find((r) => r.method === 'session/prompt')).toBeUndefined();
  });

  it('persists a fresh session id for crash-safe resume', async () => {
    mockState.setResponse('initialize', { agentCapabilities: { loadSession: true } });
    mockState.setResponse('session/new', { sessionId: 'sess-new-persist' });

    await manager.start();

    expect(mockSettings.data.acpSessionIds['NextPert::/repo']).toBe('sess-new-persist');
  });

  it('falls back to session/new and re-persists when resume of the persisted id fails', async () => {
    mockSettings.data.acpSessionIds = { 'NextPert::/repo': 'sess-stale' };
    manager = new AcpRuntimeManager('rt-stale', getProviderConfig('kimi'), {
      agentName: 'NextPert',
      workDir: '/repo',
      projectId: 42,
    });
    manager.on('event', (payload: AcpEventPayload) => events.push(payload));
    mockState.setResponse('initialize', { agentCapabilities: { loadSession: true } });
    mockState.setResponse('session/resume', new Error('invalid params: session not found'));
    mockState.setResponse('session/new', { sessionId: 'sess-fresh' });

    await manager.start();

    expect(getProcess().requests).toContainEqual(
      expect.objectContaining({ method: 'session/new' }),
    );
    expect(manager.getSessionId()).toBe('sess-fresh');
    expect(mockSettings.data.acpSessionIds['NextPert::/repo']).toBe('sess-fresh');
  });

  it('emits queue-state events on enqueue and dispatch (WO-ACP-QUEUED-PROMPT-VISIBILITY)', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-queue-vis' });
    await manager.start();
    events = [];

    const process = getProcess();
    // First prompt stays in flight until we resolve it manually.
    let resolveTurn: (value: unknown) => void = () => {};
    mockState.setResponse('session/prompt', new Promise<unknown>((resolve) => { resolveTurn = resolve; }));
    await manager.prompt('in-flight');
    // The runtime busy-rejects the steer, so the prompt takes the backstop
    // queue path — the ONLY producer of prompt_queued (slice B).
    mockState.setResponse(
      'session/prompt',
      new Error('Cannot launch a new turn while another turn (ID 1) is active'),
    );
    const queuedPromise = manager.prompt('queued behind');
    await Promise.resolve();
    await Promise.resolve();

    const queuedEvents = events.filter((e) => e.update.sessionUpdate === 'prompt_queued');
    expect(queuedEvents).toHaveLength(1);
    expect(queuedEvents[0]?.update).toMatchObject({
      sessionUpdate: 'prompt_queued',
      sessionId: 'sess-queue-vis',
      queueDepth: 1,
    });
    expect(events.find((e) => e.update.sessionUpdate === 'prompt_dequeued')).toBeUndefined();

    // Turn completes → the queued prompt dispatches with depth back to 0.
    mockState.setResponse('session/prompt', { stopReason: 'end_turn' });
    resolveTurn({ stopReason: 'end_turn' });
    await queuedPromise;

    const dequeuedEvents = events.filter((e) => e.update.sessionUpdate === 'prompt_dequeued');
    expect(dequeuedEvents).toHaveLength(1);
    expect(dequeuedEvents[0]?.update).toMatchObject({
      sessionUpdate: 'prompt_dequeued',
      sessionId: 'sess-queue-vis',
      queueDepth: 0,
    });

    manager.kill();
    void process;
  });

  it('emits queue_cleared when a watchdog restart drops queued prompts', async () => {
    // No loadSession capability → restart never resumes → fresh session →
    // queued prompts drop (and the renderer must hear queue_cleared).
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-queue-drop' });
    await manager.start();
    events = [];

    vi.useFakeTimers();
    const process = getProcess();
    mockState.setResponse('session/prompt', new Promise<unknown>(() => {})); // never resolves
    await manager.prompt('in-flight');
    void manager.prompt('queued one');
    await vi.advanceTimersByTimeAsync(0);
    // Slice B: the second prompt steers through (pendingSteer) — no
    // prompt_queued event on the steer path.
    expect(events.some((e) => e.update.sessionUpdate === 'prompt_queued')).toBe(false);

    // Trip the 300s idle watchdog: failPendingTurn + restart. The restart
    // starts a FRESH session (no resume capability), so the queue drops.
    await vi.advanceTimersByTimeAsync(320_000);
    await vi.advanceTimersByTimeAsync(1_000); // restart's post-kill 500ms pause + start

    const cleared = events.filter((e) => e.update.sessionUpdate === 'queue_cleared');
    expect(cleared.length).toBeGreaterThan(0);

    manager.kill();
    vi.useRealTimers();
    void process;
  });

  it('settles a queued injectMail as false when a restart drops the queue (WO 11462)', async () => {
    // No loadSession capability → restart never resumes → queue drops.
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-mail-drop' });
    await manager.start();

    vi.useFakeTimers();
    mockState.setResponse('session/prompt', new Promise<unknown>(() => {})); // never resolves
    await manager.prompt('in-flight');
    const mailPromise = manager.injectMail('you have mail');
    await vi.advanceTimersByTimeAsync(0);
    // The mail inject steers through (pendingSteer), not the queue.
    expect(events.some((e) => e.update.sessionUpdate === 'prompt_queued')).toBe(false);

    // Trip the 300s idle watchdog → restart → dropQueuedPrompts. The steered
    // mail inject must settle false (not hang) so the renderer's retry /
    // delivery-failed path can fire.
    await vi.advanceTimersByTimeAsync(320_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(mailPromise).resolves.toBe(false);

    manager.kill();
    vi.useRealTimers();
  });

  it('settles a queued injectMail as false on intentional kill (WO 11483)', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-mail-kill' });
    await manager.start();

    mockState.setResponse('session/prompt', new Promise<unknown>(() => {})); // never resolves
    await manager.prompt('in-flight');
    const mailPromise = manager.injectMail('you have mail');
    await Promise.resolve();
    // Steered through as a pendingSteer, not queued.
    expect(events.some((e) => e.update.sessionUpdate === 'prompt_queued')).toBe(false);

    // An intentional kill has no later drain path — the steered notice must
    // settle false immediately, not hang.
    manager.kill();

    await expect(mailPromise).resolves.toBe(false);
  });

  it('purgeQueue settles every queued prompt as false and returns the count (WO 11572)', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-purge' });
    await manager.start();

    mockState.setResponse('session/prompt', new Promise<unknown>(() => {})); // never resolves
    await manager.prompt('in-flight');
    const mailPromise = manager.injectMail('mail one');
    const mailPromise2 = manager.injectMail('mail two');
    await Promise.resolve();
    // Both steer through as pendingSteers — no prompt_queued events.
    expect(events.filter((e) => e.update.sessionUpdate === 'prompt_queued')).toHaveLength(0);

    // The human's interrupt purges the backlog: both settle false, the count
    // comes back for the UI flash, and queue_cleared fires for the renderer.
    const dropped = manager.purgeQueue();

    expect(dropped).toBe(2);
    await expect(mailPromise).resolves.toBe(false);
    await expect(mailPromise2).resolves.toBe(false);
    expect(events.some((e) => e.update.sessionUpdate === 'queue_cleared')).toBe(true);

    manager.kill();
  });

  it('settles queued prompts as false when the restart budget is exhausted (WO 11483)', async () => {
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-mail-exhaust' });
    await manager.start();

    // Fake clock BEFORE any prompt traffic so the inactivity watchdog is fake
    // from creation (mirrors the queue_cleared test above).
    vi.useFakeTimers();
    try {
      mockState.setResponse('session/prompt', new Promise<unknown>(() => {})); // never resolves
      await manager.prompt('in-flight');
      const mailPromise = manager.injectMail('you have mail');
      await vi.advanceTimersByTimeAsync(0);
      // Steered through as a pendingSteer, not queued.
      expect(events.some((e) => e.update.sessionUpdate === 'prompt_queued')).toBe(false);

      // Every subsequent start attempt fails → each restart re-schedules until
      // the budget (MAX_RESTARTS = 5) is spent and the give-up path drops the
      // queue.
      mockState.setResponse('initialize', new Error('spawn boom'));
      mockState.setResponse('session/new', new Error('spawn boom'));

      // Trip the 300s idle watchdog → first restart; then cascade through the
      // restart backoff chain + start()'s internal 2s/4s retry delays.
      await vi.advanceTimersByTimeAsync(320_000);
      await vi.advanceTimersByTimeAsync(180_000);

      expect(events.some((e) =>
        e.update.sessionUpdate === 'error' &&
        typeof e.update.error === 'string' &&
        e.update.error.includes('keeps failing'),
      )).toBe(true);
      await expect(mailPromise).resolves.toBe(false);
    } finally {
      manager.kill();
      vi.useRealTimers();
    }
  });

  it('spawns with -m alias when model_override is set (WO-KIMI-MODEL-OVERRIDE)', async () => {
    manager = new AcpRuntimeManager('rt-model', getProviderConfig('kimi'), {
      agentName: 'NextPert',
      workDir: '/repo',
      projectId: 42,
      modelOverride: 'kimi-for-coding-highspeed',
    });
    manager.on('event', (payload: AcpEventPayload) => events.push(payload));
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-model' });

    await manager.start();

    const args = getProcess().options.args;
    const mIndex = args.indexOf('-m');
    expect(mIndex).toBeGreaterThan(-1);
    expect(args[mIndex + 1]).toBe('kimi-code/kimi-for-coding-highspeed');
    expect(args[args.length - 1]).toBe('acp');
  });

  it('keeps the spawn byte-identical when model_override is null', async () => {
    manager = new AcpRuntimeManager('rt-model-null', getProviderConfig('kimi'), {
      agentName: 'NextPert',
      workDir: '/repo',
      projectId: 42,
      modelOverride: null,
    });
    manager.on('event', (payload: AcpEventPayload) => events.push(payload));
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-model-null' });

    await manager.start();

    expect(getProcess().options.args).toEqual(['--yolo', 'acp']);
    expect(getProcess().options.env).not.toHaveProperty('KIMI_MODEL_THINKING_EFFORT');
  });

  it('fails loud on an unknown model id — no spawn, no silent fallback', async () => {
    manager = new AcpRuntimeManager('rt-model-bad', getProviderConfig('kimi'), {
      agentName: 'NextPert',
      workDir: '/repo',
      projectId: 42,
      modelOverride: 'kimi-turbo-typo',
    });
    manager.on('event', (payload: AcpEventPayload) => events.push(payload));

    await expect(manager.start()).rejects.toThrow(/not a recognized kimi model/);
    // No process may ever exist for an unrecognized id.
    expect(mockState.lastInstance).toBeNull();
  });

  it('injects KIMI_MODEL_THINKING_EFFORT for k3 with an effort override', async () => {
    manager = new AcpRuntimeManager('rt-k3-effort', getProviderConfig('kimi'), {
      agentName: 'NextPert',
      workDir: '/repo',
      projectId: 42,
      effort: 'high',
      modelOverride: 'k3',
    });
    manager.on('event', (payload: AcpEventPayload) => events.push(payload));
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-k3' });

    await manager.start();

    expect(getProcess().options.env?.KIMI_MODEL_THINKING_EFFORT).toBe('high');
    expect(getProcess().options.args).toContain('kimi-code/k3');
  });

  it('does not inject thinking effort for non-k3 models', async () => {
    manager = new AcpRuntimeManager('rt-k27-effort', getProviderConfig('kimi'), {
      agentName: 'NextPert',
      workDir: '/repo',
      projectId: 42,
      effort: 'high',
      modelOverride: 'kimi-for-coding',
    });
    manager.on('event', (payload: AcpEventPayload) => events.push(payload));
    mockState.setResponse('initialize', {});
    mockState.setResponse('session/new', { sessionId: 'sess-k27' });

    await manager.start();

    expect(getProcess().options.env).not.toHaveProperty('KIMI_MODEL_THINKING_EFFORT');
    expect(getProcess().options.args).toContain('kimi-code/kimi-for-coding');
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
      stopReason: 'cancelled',
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
