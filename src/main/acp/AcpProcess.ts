import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

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

export class AcpProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number | string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private buffer = '';
  private killed = false;

  constructor(private readonly options: AcpProcessOptions) {
    super();
  }

  start(): void {
    if (this.child) return;

    this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdoutData(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => this.emit('stderr', chunk));

    this.child.on('error', (err) => {
      this.emit('error', err);
      this.rejectAllPending(err);
    });

    this.child.on('exit', (code, signal) => {
      this.emit('exit', code, signal);
      this.rejectAllPending(new Error(`ACP process exited (code=${code}, signal=${signal})`));
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.killed || !this.child) {
        reject(new Error('ACP process is not running'));
        return;
      }

      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });

      const message: AcpJsonRpcMessage = { jsonrpc: '2.0', id, method, params };
      this.write(message);

      // Timeout safety: reject if no response in 60 seconds.
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`ACP request ${method} timed out`));
        }
      }, 60000);
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
    if (this.child && !this.child.killed) {
      this.child.kill(signal);
    }
    this.rejectAllPending(new Error('ACP process killed'));
  }

  isRunning(): boolean {
    return this.child !== null && !this.child.killed && this.killed === false;
  }

  private write(message: AcpJsonRpcMessage): void {
    const line = JSON.stringify(message) + '\n';
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(line);
    } else {
      this.emit('error', new Error('ACP process stdin is not writable'));
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
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
        } else {
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
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}
