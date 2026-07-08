import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { AcpProcess } from './AcpProcess';

class MockChild extends EventEmitter {
  pid = 1234;
  killed = false;
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

describe('AcpProcess', () => {
  let child: MockChild;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    child = new MockChild();
    mockSpawn.mockReturnValue(child as unknown as ChildProcess);
  });

  it('spawns the configured command and args', () => {
    const proc = new AcpProcess({ command: 'kimi', args: ['acp'], cwd: '/repo' });
    proc.start();
    expect(mockSpawn).toHaveBeenCalledWith(
      'kimi',
      ['acp'],
      expect.objectContaining({ cwd: '/repo', stdio: ['pipe', 'pipe', 'pipe'], shell: false }),
    );
  });

  it('passes the requested env vars through to the child process', () => {
    const proc = new AcpProcess({
      command: 'kimi',
      args: ['acp'],
      cwd: '/repo',
      env: { NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CI: 'true' },
    });
    proc.start();
    expect(mockSpawn).toHaveBeenCalledWith(
      'kimi',
      ['acp'],
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({ NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CI: 'true' }),
      }),
    );
  });

  it('emits parsed notifications from stdout', () => {
    const proc = new AcpProcess({ command: 'kimi', args: ['acp'] });
    const listener = vi.fn();
    proc.on('notification', listener);
    proc.start();
    child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: {} } }) + '\n');
    expect(listener).toHaveBeenCalledWith('session/update', { update: {} }, undefined);
  });

  it('correlates request/response and resolves with the result', async () => {
    const proc = new AcpProcess({ command: 'kimi', args: ['acp'] });
    proc.start();
    const writeSpy = vi.spyOn(child.stdin, 'write');
    const promise = proc.request('initialize', { protocolVersion: 1 });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeSpy.mock.calls[0][0] as string)).toMatchObject({ jsonrpc: '2.0', method: 'initialize' });
    child.stdout.emit(
      'data',
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n',
    );
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('rejects a request when the response contains an error', async () => {
    const proc = new AcpProcess({ command: 'kimi', args: ['acp'] });
    proc.start();
    const promise = proc.request('session/new', {});
    child.stdout.emit(
      'data',
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid Request' } }) + '\n',
    );
    await expect(promise).rejects.toThrow('Invalid Request (code -32600)');
  });

  it('emits stderr lines', () => {
    const proc = new AcpProcess({ command: 'kimi', args: ['acp'] });
    const listener = vi.fn();
    proc.on('stderr', listener);
    proc.start();
    child.stderr.emit('data', 'something went wrong\n');
    expect(listener).toHaveBeenCalledWith('something went wrong\n');
  });

  it('emits an error for non-JSON stdout lines instead of forwarding them', () => {
    const proc = new AcpProcess({ command: 'kimi', args: ['acp'] });
    const notificationListener = vi.fn();
    const errorListener = vi.fn();
    proc.on('notification', notificationListener);
    proc.on('error', errorListener);
    proc.start();

    child.stdout.emit('data', '[ACP system] spawn complete\n');
    child.stdout.emit('data', '[ACP mail] New message from BAPert\n');

    expect(notificationListener).not.toHaveBeenCalled();
    expect(errorListener).toHaveBeenCalledTimes(2);
    expect(errorListener.mock.calls[0][0].message).toContain('Invalid JSON from ACP stdout');
    expect(errorListener.mock.calls[1][0].message).toContain('Invalid JSON from ACP stdout');
  });

  it('rejects pending requests on process error', async () => {
    const proc = new AcpProcess({ command: 'kimi', args: ['acp'] });
    proc.on('error', () => {}); // swallow the re-emitted error
    proc.start();
    const promise = proc.request('initialize', {});
    child.emit('error', new Error('spawn failed'));
    await expect(promise).rejects.toThrow('spawn failed');
  });

  it('times out a request after 60 seconds', async () => {
    const proc = new AcpProcess({ command: 'kimi', args: ['acp'] });
    proc.start();
    const promise = proc.request('initialize', {});
    vi.advanceTimersByTime(60001);
    await expect(promise).rejects.toThrow('timed out');
  });

  it('kills the child process', () => {
    const proc = new AcpProcess({ command: 'kimi', args: ['acp'] });
    proc.start();
    proc.kill('SIGTERM');
    expect(child.killed).toBe(true);
  });
});
