import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

/**
 * The process surface AcpRuntimeManager drives. AcpProcess (ACP/JSON-RPC
 * stdio) and ClaudeStreamJsonTransport (Claude stream-json NDJSON adapted to
 * the same calls — WO-G4) both satisfy it; the manager stays
 * protocol-agnostic.
 */
export interface AcpTransport {
  start(): void;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  respond(id: number | string, result: unknown): void;
  kill(signal?: NodeJS.Signals): void;
  isRunning(): boolean;
  on(event: 'notification', listener: (method: string, params: unknown, id?: number | string) => void): this;
  on(event: 'stderr', listener: (text: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
}

export interface AcpJsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  method: string;
}

export class AcpProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private buffer = '';
  private killed = false;
  private exitFired = false;
  private writeQueue: string[] = [];
  private writePending = false;

  constructor(private readonly options: AcpProcessOptions) {
    super();
  }

  start(): void {
    if (this.child) return;

    const [command, ...args] = [this.options.command, ...this.options.args];
    this.child = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // Don't pop up a console window for the child process on Windows.
      windowsHide: true,
    });

    console.log(`[ACP process] spawned ${command} ${args.join(' ')} (pid=${this.child.pid ?? 'unknown'})`);

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdoutData(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => this.emit('stderr', chunk));

    this.child.on('error', (err) => {
      console.error(`[ACP process] spawn error for ${command}:`, err);
      this.emit('error', err);
      this.rejectAllPending(err);
    });

    this.child.on('exit', (code, signal) => {
      if (this.exitFired) return;
      this.exitFired = true;
      console.log(`[ACP process] exited ${command} (code=${code}, signal=${signal}, pid=${this.child?.pid ?? 'unknown'})`);
      this.emit('exit', code, signal);
      this.rejectAllPending(new Error(`ACP process exited (code=${code}, signal=${signal})`));
    });

    this.child.on('close', () => {
      // Drain any remaining stdout before finalizing exit handling.
      if (this.buffer.trim()) {
        this.parseLine(this.buffer.trim());
        this.buffer = '';
      }
    });
  }

  request(method: string, params?: unknown, timeoutMs = 60000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.killed || !this.child) {
        reject(new Error('ACP process is not running'));
        return;
      }

      const id = ++this.requestId;
      const pending: PendingRequest = { resolve, reject, method };
      this.pendingRequests.set(id, pending);
      console.log(`[ACP process] >>> ${method} id=${id}`);

      const message: AcpJsonRpcMessage = { jsonrpc: '2.0', id, method, params };
      this.write(message);

      if (timeoutMs <= 0) return;

      // Timeout safety: reject if no response in the allotted time. Long-running
      // streaming requests (e.g., session/prompt) pass timeoutMs=0 and rely on the
      // AcpRuntimeManager-level watchdog instead.
      pending.timer = setTimeout(() => {
        if (!this.pendingRequests.has(id)) return;
        this.pendingRequests.delete(id);
        const err = new Error(`ACP request ${method} timed out`);
        console.warn(`[ACP process] ${method} timed out; terminating runtime`);
        reject(err);
        this.kill('SIGTERM');
        // Guarantee the process is gone even if SIGTERM is ignored (Windows).
        setTimeout(() => this.forceKill(), 3000);
      }, timeoutMs);
    });
  }

  notify(method: string, params?: unknown): void {
    const message: AcpJsonRpcMessage = { jsonrpc: '2.0', method, params };
    this.write(message);
  }

  respond(id: number | string, result: unknown): void {
    const message: AcpJsonRpcMessage = { jsonrpc: '2.0', id, result };
    this.write(message);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.killed = true;
    this.rejectAllPending(new Error('ACP process killed'));
    if (!this.child || this.child.killed) {
      this.child = null;
      return;
    }
    try {
      this.child.kill(signal);
    } catch (err) {
      console.warn(`[ACP process] kill(${signal}) failed:`, err);
    }
    // Give SIGTERM a moment, then escalate to SIGKILL / taskkill so we don't
    // leave a zombie runtime holding locks on Windows.
    setTimeout(() => this.forceKill(), 2000);
  }

  isRunning(): boolean {
    if (this.killed || !this.child) return false;
    if (this.child.killed) return false;
    // exitCode/signalCode are set as soon as the OS reports the process gone,
    // even before the 'exit' event has been processed.
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  private forceKill(): void {
    if (!this.child || this.child.killed) {
      this.child = null;
      return;
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.child = null;
      return;
    }
    console.warn(`[ACP process] escalating to force kill (pid=${this.child.pid ?? 'unknown'})`);
    try {
      this.child.kill('SIGKILL');
    } catch {
      // ignore
    }
    if (process.platform === 'win32' && this.child.pid) {
      setTimeout(() => {
        if (!this.child || this.child.killed) return;
        if (this.child.exitCode !== null || this.child.signalCode !== null) return;
        console.warn(`[ACP process] using taskkill /F /T for pid=${this.child.pid}`);
        try {
          spawn('taskkill', ['/F', '/T', '/PID', String(this.child.pid)], { windowsHide: true, detached: true });
        } catch {
          // ignore
        }
      }, 1500);
    }
  }

  private write(message: AcpJsonRpcMessage): void {
    const line = JSON.stringify(message) + '\n';
    this.writeQueue.push(line);
    this.drainWriteQueue();
  }

  private drainWriteQueue(): void {
    if (this.writePending || !this.child?.stdin || this.child.stdin.destroyed) return;
    const line = this.writeQueue.shift();
    if (!line) return;
    if (!this.child.stdin.writable) {
      this.emit('error', new Error('ACP process stdin is not writable'));
      return;
    }
    this.writePending = true;
    const ok = this.child.stdin.write(line, (err) => {
      if (err) this.emit('error', err);
    });
    if (ok !== false) {
      this.writePending = false;
      setImmediate(() => this.drainWriteQueue());
    } else {
      this.child.stdin.once('drain', () => {
        this.writePending = false;
        this.drainWriteQueue();
      });
    }
  }

  private onStdoutData(chunk: string): void {
    this.buffer += chunk;
    let boundary: number;
    while ((boundary = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary + 1);
      if (line) {
        this.parseLine(line);
      }
    }
  }

  private parseLine(line: string): void {
    let message: AcpJsonRpcMessage;
    try {
      message = JSON.parse(line) as AcpJsonRpcMessage;
    } catch (err) {
      this.emit('error', new Error(`Invalid JSON from ACP stdout: ${line}`));
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        if (message.error) {
          console.error(`[ACP process] <<< error id=${message.id} (${pending.method}): ${message.error.message} (code ${message.error.code})`);
          pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
        } else {
          console.log(`[ACP process] <<< result id=${message.id} (${pending.method})`);
          pending.resolve(message.result);
        }
      }
    } else if (message.method) {
      this.emit('notification', message.method, message.params, message.id);
    } else {
      this.emit('error', new Error(`Unrecognized ACP message: ${line}`));
    }
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}
