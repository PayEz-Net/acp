/**
 * WO-G4 (kanban 117423) — ClaudeStreamJsonTransport.
 *
 * Adapts Claude's stream-json wire (NOT JSON-RPC — see claudeStreamJson.ts)
 * to the AcpProcess-shaped surface AcpRuntimeManager drives: start(), request/
 * notify/respond, kill(), isRunning(), and 'notification' | 'stderr' | 'error'
 * | 'exit' events. The manager stays protocol-agnostic; this class speaks ACP
 * upward and NDJSON downward.
 *
 * One long-lived child serves all turns (`ClaudeStreamJsonBridge`). Every wire
 * event is persisted by the bridge BEFORE mapping, so the store survives the
 * pane being killed even if this transport is mid-map when it dies.
 *
 * Cancel semantics (A-4): session/cancel PREEMPTS. Claude answers an interrupt
 * control_request with control_response and then settles the turn with
 * result/error_during_execution (is_error) — wire-verified 2026-08-14 on
 * claude 2.1.231. We resolve the pending prompt as `cancelled` the moment we
 * send the interrupt (no drain wait) and SWALLOW that trailing error result:
 * the client cancelled on purpose, so the pane must not show an error line.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { ClaudeStreamJsonBridge } from './ClaudeStreamJsonBridge';
import {
  ClaudeStreamJsonMapper,
  encodeUserTurn,
  type ClaudeStreamJsonEvent,
} from './claudeStreamJson';

export interface ClaudeStreamJsonTransportOptions {
  agentName: string;
  /** Stable per-pane working directory (resume depends on it). */
  workDir: string;
  /** Base dir for the bridge event store, e.g. <userData>/bridge-events. */
  eventStoreDir: string;
  /** Command override for tests (default 'claude'). */
  command?: string;
  /** Args prepended before the stream-json flags (tests inject a fixture). */
  commandArgsPrefix?: string[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ClaudeStreamJsonTransport extends EventEmitter {
  private bridge: ClaudeStreamJsonBridge | null = null;
  private mapper = new ClaudeStreamJsonMapper();
  private killed = false;

  /** The single in-flight turn. Claude serves turns sequentially; a second
   * prompt mid-turn is a steer, not a queue entry. */
  private pendingPrompt: PendingRequest | null = null;
  /** Awaits readiness after a (re)spawn — initialize/session/new/resume.
   * Readiness is the initialize control_response (2.1.231 defers system/init
   * until the first turn); a system/init also satisfies it (older versions). */
  private awaitingInit: PendingRequest | null = null;
  /** True once the current child answered the initialize handshake. */
  private handshook = false;
  /** request_id of the in-flight initialize handshake (echoed back). */
  private handshakeId: string | null = null;
  /** True after WE interrupted: the next is_error result is the interrupted
   * turn settling, not a failure — swallow it (see header). */
  private expectInterruptError = false;

  constructor(private readonly options: ClaudeStreamJsonTransportOptions) {
    super();
  }

  start(): void {
    if (this.killed || this.bridge?.isRunning()) return;
    // A fresh process carries a client-chosen session id from the start:
    // 2.1.231 emits no system/init until the first turn, so without
    // --session-id the id would be unknowable until then.
    this.spawnBridge(null, randomUUID());
  }

  isRunning(): boolean {
    return !this.killed && (this.bridge?.isRunning() ?? false);
  }

  hasTurnInFlight(): boolean {
    return this.pendingPrompt !== null;
  }

  getSessionId(): string | null {
    return this.bridge?.getSessionId() ?? null;
  }

  request(method: string, params?: unknown, timeoutMs = 60000): Promise<unknown> {
    if (this.killed) return Promise.reject(new Error('ACP process is not running'));

    switch (method) {
      case 'initialize':
        return this.withTimeout(this.awaitInit(), timeoutMs);
      case 'session/new':
        return this.sessionNew();
      case 'session/resume':
        return this.sessionResume(params);
      case 'session/prompt':
        return this.sessionPrompt(params);
      default:
        return Promise.reject(new Error(`Unsupported method for claude transport: ${method}`));
    }
  }

  notify(method: string, params?: unknown): void {
    if (this.killed) return;
    if (method === 'session/cancel') this.cancel();
  }

  /** No permission channel: claude runs with the PTY path's skip-permissions
   * flag, so there is never a permission request to answer. */
  respond(_id: number | string, _result: unknown): void {
    // Deliberately a no-op.
  }

  kill(_signal?: NodeJS.Signals): void {
    if (this.killed) return;
    this.killed = true;
    this.rejectPending(new Error('ACP process killed'));
    this.bridge?.kill();
    this.bridge = null;
  }

  // ---------------------------------------------------------------- internal

  private spawnBridge(resumeSessionId: string | null, newSessionId: string | null = null): void {
    const bridge = new ClaudeStreamJsonBridge({
      agentName: this.options.agentName,
      workDir: this.options.workDir,
      eventStoreDir: this.options.eventStoreDir,
      resumeSessionId,
      newSessionId,
      command: this.options.command,
      commandArgsPrefix: this.options.commandArgsPrefix,
    });
    this.bridge = bridge;
    this.mapper = new ClaudeStreamJsonMapper();
    this.handshook = false;

    bridge.on('event', (event: ClaudeStreamJsonEvent) => this.onWireEvent(event));
    bridge.on('stderr', (text: string) => this.emit('stderr', text));
    bridge.on('error', (err: Error) => this.emit('error', err));
    bridge.on('exit', (code: number | null, signal: string | null) => {
      // A superseded bridge (killed by session/resume's respawn) dying is
      // expected — its exit must not reject the NEW spawn's waiters.
      if (this.bridge !== bridge) return;
      // A spawn awaiting init that exits first = the CLI rejected us (e.g.
      // --resume with an unknown session id exits 1). Reject the waiter so
      // the manager falls back to session/new.
      if (this.awaitingInit) {
        const pending = this.awaitingInit;
        this.awaitingInit = null;
        pending.reject(new Error(`claude exited before init (code=${code}, signal=${signal})`));
      }
      this.rejectPending(new Error(`ACP process exited (code=${code}, signal=${signal})`));
      this.emit('exit', code, signal);
    });

    bridge.start();

    // Readiness probe: the initialize control handshake. If the write races
    // the spawn dying, the exit handler rejects the waiter instead.
    this.handshakeId = `init-${Date.now()}`;
    try {
      bridge.initializeHandshake(this.handshakeId);
    } catch { /* exit path settles the waiter */ }
  }

  private onWireEvent(event: ClaudeStreamJsonEvent): void {
    if (this.awaitingInit) {
      const response = event.response as { request_id?: unknown } | undefined;
      const isHandshake =
        event.type === 'control_response' &&
        typeof response?.request_id === 'string' &&
        response.request_id === this.handshakeId;
      const isInit = event.type === 'system' && event.subtype === 'init';
      if (isHandshake || isInit) {
        const pending = this.awaitingInit;
        this.awaitingInit = null;
        this.handshook = true;
        pending.resolve({
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: {
            name: 'Claude Code',
            version:
              typeof event.claude_code_version === 'string' ? event.claude_code_version : undefined,
          },
        });
      }
    }

    // The interrupted turn's trailing error result: expected, not a failure.
    if (this.expectInterruptError && event.type === 'result') {
      this.expectInterruptError = false;
      if (event.is_error === true || event.subtype === 'error_during_execution') return;
      // Not the interrupt settling after all — fall through and map it.
    }

    for (const update of this.mapper.map(event)) {
      this.emit('notification', 'session/update', {
        sessionId: this.getSessionId() ?? undefined,
        update,
      });
    }

    if (event.type === 'result' && this.pendingPrompt) {
      const pending = this.pendingPrompt;
      this.pendingPrompt = null;
      pending.resolve({
        stopReason:
          typeof event.stop_reason === 'string' && event.stop_reason
            ? event.stop_reason
            : 'end_turn',
      });
    }
  }

  private awaitInit(): Promise<unknown> {
    if (!this.bridge) return Promise.reject(new Error('ACP process is not running'));
    if (this.handshook) {
      return Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'Claude Code' },
      });
    }
    return new Promise((resolve, reject) => {
      this.awaitingInit = { resolve, reject };
    });
  }

  private async sessionNew(): Promise<unknown> {
    if (!this.bridge?.isRunning()) {
      // Fresh session after a failed resume (or a dead child): respawn clean.
      this.spawnBridge(null, randomUUID());
      await this.awaitInit();
    }
    return { sessionId: this.getSessionId() };
  }

  private async sessionResume(params: unknown): Promise<unknown> {
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('session/resume requires a sessionId');
    }
    // Resume REPLACES the process: the CLI carries session state, not us.
    // spawnBridge resets `handshook`, so this awaits the new child's handshake
    // (a BOGUS id exits 1 first and the exit handler rejects).
    this.bridge?.kill();
    this.spawnBridge(sessionId);
    await this.awaitInit();
    return { sessionId: this.getSessionId() };
  }

  private sessionPrompt(params: unknown): Promise<unknown> {
    if (!this.bridge?.isRunning()) {
      return Promise.reject(new Error('ACP process is not running'));
    }
    const blocks = (params as { prompt?: unknown } | undefined)?.prompt;
    const text = Array.isArray(blocks)
      ? blocks
          .map((b) => (b as { type?: string; text?: string }))
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
      : '';

    if (this.pendingPrompt) {
      // Steer: written immediately, resolves without waiting for the turn.
      this.bridge.prompt(text);
      return Promise.resolve({ stopReason: 'steered' });
    }

    return new Promise((resolve, reject) => {
      this.pendingPrompt = { resolve, reject };
      try {
        this.bridge!.prompt(text);
      } catch (err) {
        this.pendingPrompt = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** ESC. Preempts: settle the in-flight prompt NOW, tell Claude to interrupt. */
  private cancel(): void {
    const pending = this.pendingPrompt;
    if (!pending) return;
    this.pendingPrompt = null;
    this.expectInterruptError = true;
    if (this.bridge?.isRunning()) {
      try {
        this.bridge.interrupt();
      } catch {
        // Child died between isRunning and the write — the exit path settles.
      }
    }
    for (const update of this.mapper.cancelTurn()) {
      this.emit('notification', 'session/update', {
        sessionId: this.getSessionId() ?? undefined,
        update,
      });
    }
    pending.resolve({ stopReason: 'cancelled' });
  }

  private rejectPending(err: Error): void {
    if (this.awaitingInit) {
      const pending = this.awaitingInit;
      this.awaitingInit = null;
      pending.reject(err);
    }
    if (this.pendingPrompt) {
      const pending = this.pendingPrompt;
      this.pendingPrompt = null;
      pending.reject(err);
    }
  }

  private withTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<unknown> {
    if (timeoutMs <= 0) return promise;
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('ACP request timed out')), timeoutMs),
      ),
    ]);
  }
}
