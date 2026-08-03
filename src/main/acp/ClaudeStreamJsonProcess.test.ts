/**
 * WO-G4 — Claude stream-json process adapter tests.
 *
 * The mapper's wire fixtures are pinned in `claudeStreamJson.test.ts`; this
 * file covers the ADAPTER: the turn loop (stdin encode → stdout events →
 * resolve), the session id the caller pinned in the spawn args, and the
 * cancel/exit paths that settle a turn without a `result`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { AcpSessionUpdate } from '../../shared/acpTypes';
import { ClaudeStreamJsonProcess, extractSessionIdFromArgs } from './ClaudeStreamJsonProcess';

class MockChild extends EventEmitter {
  pid = 4321;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), writable: true }) as EventEmitter & { write: ReturnType<typeof vi.fn>; writable: boolean };
  stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() }) as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() }) as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };

  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit('exit', 0, 'SIGTERM');
    return true;
  }
}

const mockSpawn = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: Parameters<typeof mockSpawn>) => mockSpawn(...args),
}));

const SESSION = '44efa7e0-30c2-4adc-b2fc-a83a3e686348';

const STREAM_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
];

const line = (o: Record<string, unknown>): string =>
  `${JSON.stringify({ session_id: SESSION, ...o })}\n`;

describe('extractSessionIdFromArgs', () => {
  it('reads the session the caller pinned at spawn', () => {
    expect(extractSessionIdFromArgs([...STREAM_ARGS, '--session-id', SESSION])).toBe(SESSION);
    expect(extractSessionIdFromArgs([...STREAM_ARGS, '--resume', SESSION])).toBe(SESSION);
    expect(extractSessionIdFromArgs([...STREAM_ARGS, `--session-id=${SESSION}`])).toBe(SESSION);
  });

  it('returns empty when no session flag is present', () => {
    expect(extractSessionIdFromArgs(STREAM_ARGS)).toBe('');
    // A dangling flag carries no id — it must not swallow the next flag.
    expect(extractSessionIdFromArgs([...STREAM_ARGS, '--resume', '--verbose'])).toBe('');
  });
});

describe('ClaudeStreamJsonProcess', () => {
  let child: MockChild;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    child = new MockChild();
    mockSpawn.mockReturnValue(child as unknown as ChildProcess);
  });

  const makeProc = (args: string[] = [...STREAM_ARGS, '--session-id', SESSION]) => {
    const proc = new ClaudeStreamJsonProcess({ command: 'claude', args, cwd: '/repo' });
    proc.start();
    return proc;
  };

  it('spawns the caller-supplied command and args verbatim', () => {
    makeProc();
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      [...STREAM_ARGS, '--session-id', SESSION],
      expect.objectContaining({ cwd: '/repo', stdio: ['pipe', 'pipe', 'pipe'], shell: false }),
    );
  });

  it('answers initialize with Claude capabilities without touching the child', async () => {
    const proc = makeProc();
    await expect(proc.request('initialize', { protocolVersion: 1 })).resolves.toEqual({
      agentCapabilities: {
        // false on purpose: claude session RESTORE is not supported yet, so the
        // adapter must not advertise it (see the fresh-session-only change in
        // ClaudeStreamJsonProcess + AcpRuntimeManager). Flip this back to true
        // in the same commit that re-enables resume, never on its own.
        loadSession: false,
        promptCapabilities: { image: true, embeddedContext: true },
      },
      agentInfo: { name: 'Claude Code' },
    });
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  it('acknowledges session/new and session/resume with the spawn-time session', async () => {
    const proc = makeProc([...STREAM_ARGS, '--resume', SESSION]);
    await expect(proc.request('session/new', { cwd: '/repo' })).resolves.toEqual({ sessionId: SESSION });
    await expect(proc.request('session/resume', { sessionId: SESSION })).resolves.toEqual({ sessionId: SESSION });
  });

  it('returns the spawned session even when resume asks for a different one', async () => {
    const proc = makeProc([...STREAM_ARGS, '--session-id', SESSION]);
    await expect(proc.request('session/resume', { sessionId: 'some-other-session' })).resolves.toEqual({
      sessionId: SESSION,
    });
  });

  it('runs a turn: encodes stdin, streams updates, resolves on result', async () => {
    const proc = makeProc();
    const updates: AcpSessionUpdate[] = [];
    proc.on('sessionUpdate', (u: AcpSessionUpdate) => updates.push(u));

    const turn = proc.request('session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: 'hello' }] }, 0);

    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(JSON.parse((child.stdin.write.mock.calls[0][0] as string).trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });

    child.stdout.emit(
      'data',
      line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } }),
    );
    child.stdout.emit('data', line({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' }));

    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' });
    expect(updates).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        sessionId: SESSION,
        content: { type: 'content', content: { type: 'text', text: 'Hi' } },
      },
      { sessionUpdate: 'turn_complete', sessionId: SESSION, stopReason: 'end_turn' },
    ]);
  });

  it('resolves an errored result with the same stopReason the mapper emitted', async () => {
    // The manager builds its OWN turn_complete from this resolve value, so a
    // mismatch would leave a failed turn reading `end_turn` in the pane.
    const proc = makeProc();
    const updates: AcpSessionUpdate[] = [];
    proc.on('sessionUpdate', (u: AcpSessionUpdate) => updates.push(u));
    const turn = proc.request('session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: 'hi' }] }, 0);

    child.stdout.emit('data', line({ type: 'result', subtype: 'error', is_error: true, result: 'rate limited' }));

    await expect(turn).resolves.toEqual({ stopReason: 'error' });
    expect(updates).toEqual([
      { sessionUpdate: 'error', sessionId: SESSION, error: 'rate limited' },
      { sessionUpdate: 'turn_complete', sessionId: SESSION, stopReason: 'error' },
    ]);
  });

  it('reassembles events split across stdout chunks', async () => {
    const proc = makeProc();
    const updates: AcpSessionUpdate[] = [];
    proc.on('sessionUpdate', (u: AcpSessionUpdate) => updates.push(u));
    const turn = proc.request('session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: 'go' }] }, 0);

    const raw = line({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' });
    child.stdout.emit('data', raw.slice(0, 20));
    expect(updates).toHaveLength(0);
    child.stdout.emit('data', raw.slice(20));

    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' });
    expect(updates).toEqual([{ sessionUpdate: 'turn_complete', sessionId: SESSION, stopReason: 'end_turn' }]);
  });

  it('refuses a second concurrent turn', async () => {
    const proc = makeProc();
    void proc.request('session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: 'one' }] }, 0);
    await expect(
      proc.request('session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: 'two' }] }, 0),
    ).rejects.toThrow('already in flight');
  });

  it('cancel settles the turn with turn_complete and kills the child', async () => {
    const proc = makeProc();
    const updates: AcpSessionUpdate[] = [];
    proc.on('sessionUpdate', (u: AcpSessionUpdate) => updates.push(u));
    const turn = proc.request('session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: 'long job' }] }, 0);

    // The manager's watchdog and the human-reply backstop both cancel by
    // NOTIFY, not request — this path must work.
    proc.notify('session/cancel', { sessionId: SESSION });

    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' });
    expect(updates).toEqual([
      { sessionUpdate: 'turn_complete', sessionId: SESSION, stopReason: 'cancelled' },
    ]);
    expect(child.killed).toBe(true);
    expect(proc.isRunning()).toBe(false);
  });

  it('rejects an in-flight turn when the child exits on its own', async () => {
    const proc = makeProc();
    const turn = proc.request('session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: 'hi' }] }, 0);
    child.emit('exit', 1, null);
    await expect(turn).rejects.toThrow('Claude process exited');
  });

  it('times out a turn when the caller sets a deadline', async () => {
    const proc = makeProc();
    const turn = proc.request('session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: 'hi' }] }, 60000);
    vi.advanceTimersByTime(60001);
    await expect(turn).rejects.toThrow('timed out');
  });

  it('emits stderr chunks unchanged', () => {
    const proc = makeProc();
    const listener = vi.fn();
    proc.on('stderr', listener);
    child.stderr.emit('data', 'claude: rate limited\n');
    expect(listener).toHaveBeenCalledWith('claude: rate limited\n');
  });

  it('never emits mapped updates on the notification channel', () => {
    const proc = makeProc();
    const notification = vi.fn();
    proc.on('notification', notification);
    child.stdout.emit('data', line({ type: 'result', subtype: 'success', stop_reason: 'end_turn' }));
    expect(notification).not.toHaveBeenCalled();
  });
});
