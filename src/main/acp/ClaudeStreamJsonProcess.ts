/**
 * Claude Code `stream-json` → ACP process adapter (WO-G4).
 *
 * `AcpRuntimeManager` drives an agent over JSON-RPC on stdio via
 * {@link AcpProcess}. Claude Code has no ACP mode; its structured mode
 *
 *   claude -p --output-format stream-json --input-format stream-json \
 *          --verbose --include-partial-messages
 *
 * is a DIFFERENT protocol that merely also happens to be JSON: no `jsonrpc`
 * envelope, no request ids, no `session/update` method — one NDJSON event per
 * line (see `claudeStreamJson.ts`).
 *
 * This class is the shim between the two. It presents the same surface as
 * `AcpProcess` — `start` / `request` / `notify` / `respond` / `kill` /
 * `isRunning`, same constructor options, same kill/forceKill/taskkill ladder —
 * so the manager can drive Claude unchanged, while underneath it speaks
 * stream-json.
 *
 * Two deliberate differences from AcpProcess, both load-bearing:
 *
 *  1. Mapped output leaves on a NEW `'sessionUpdate'` channel carrying an
 *     {@link AcpSessionUpdate}, NOT `'notification'`. These events are ALREADY
 *     translated here by {@link ClaudeStreamJsonMapper}; running the manager's
 *     JSON-RPC notification mapping over them a second time would mangle them.
 *  2. There is no request/response correlation, because the wire has none.
 *     `initialize` / `session/new` / `session/resume` are answered locally from
 *     what the caller spawned; only `session/prompt` really crosses the wire,
 *     and its "response" is the next `result` event.
 *
 * The adapter does NOT choose the session. The caller passes fully-formed args
 * (CLAUDE_STREAM_JSON_ARGS plus any `--session-id` / `--resume`) and the
 * session id is read back out of those args — one spawn, one session.
 */

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

import type { AcpSendContentBlock, AcpSessionUpdate } from '../../shared/acpTypes';
import type { AcpProcessOptions } from './AcpProcess';
import {
  ClaudeStreamJsonMapper,
  NdjsonSplitter,
  encodeUserTurn,
  type ClaudeStreamJsonEvent,
} from './claudeStreamJson';

/** Params the manager sends with `session/prompt`. */
interface SessionPromptParams {
  sessionId?: string;
  prompt?: AcpSendContentBlock[];
}

/** Params the manager sends with `session/resume`. */
interface SessionResumeParams {
  sessionId?: string;
}

/**
 * The single in-flight turn. Claude serves one turn at a time on a process, so
 * unlike AcpProcess's pendingRequests map there is at most one of these.
 */
interface PendingTurn {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Read the session id out of the spawn args. Claude's session is fixed at
 * spawn time by `--session-id <uuid>` (new) or `--resume <uuid>` (existing),
 * so the args ARE the source of truth — the adapter never invents one.
 *
 * Both `--flag value` and `--flag=value` are accepted; the CLI takes either.
 */
export function extractSessionIdFromArgs(args: readonly string[]): string {
  const FLAGS = ['--session-id', '--resume'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    for (const flag of FLAGS) {
      if (arg === flag) {
        const value = args[i + 1];
        // A bare trailing flag, or one followed by another flag, carries no id.
        if (value && !value.startsWith('-')) return value;
      }
      if (arg.startsWith(`${flag}=`)) {
        const value = arg.slice(flag.length + 1);
        if (value) return value;
      }
    }
  }
  return '';
}

/** Flatten a prompt's text blocks into the one string a Claude turn accepts. */
function promptText(prompt: AcpSendContentBlock[] | undefined): string {
  if (!Array.isArray(prompt)) return '';
  return prompt
    .filter((block): block is Extract<AcpSendContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .filter(Boolean)
    .join('\n');
}

export class ClaudeStreamJsonProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private readonly splitter = new NdjsonSplitter();
  private readonly mapper = new ClaudeStreamJsonMapper();
  private pendingTurn: PendingTurn | null = null;
  private killed = false;
  private exitFired = false;
  private writeQueue: string[] = [];
  private writePending = false;
  /** Session id the caller pinned in the spawn args; '' when it pinned none. */
  private readonly spawnSessionId: string;

  constructor(private readonly options: AcpProcessOptions) {
    super();
    this.spawnSessionId = extractSessionIdFromArgs(options.args);
  }

  start(): void {
    if (this.child) return;

    const { command, args } = this.options;
    this.child = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // Don't pop up a console window for the child process on Windows.
      windowsHide: true,
    });

    console.log(
      `[claude stream-json] spawned ${command} ${args.join(' ')} (pid=${this.child.pid ?? 'unknown'}, session=${this.spawnSessionId || 'unpinned'})`,
    );

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdoutData(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => this.emit('stderr', chunk));

    this.child.on('error', (err) => {
      console.error(`[claude stream-json] spawn error for ${command}:`, err);
      this.emit('error', err);
      this.failTurn(err);
    });

    this.child.on('exit', (code, signal) => {
      if (this.exitFired) return;
      this.exitFired = true;
      console.log(
        `[claude stream-json] exited ${command} (code=${code}, signal=${signal}, pid=${this.child?.pid ?? 'unknown'})`,
      );
      this.emit('exit', code, signal);
      this.failTurn(new Error(`Claude process exited (code=${code}, signal=${signal})`));
    });

    this.child.on('close', () => {
      // Drain a final event that arrived without its trailing newline. The
      // splitter only releases newline-terminated lines, so push one to flush
      // the tail; a genuinely empty buffer yields nothing.
      for (const event of this.splitter.push('\n')) {
        this.handleEvent(event);
      }
    });
  }

  /**
   * Answer an ACP request. Only `session/prompt` reaches the child — the rest
   * are answered locally from what was spawned, because Claude's stream-json
   * has no equivalent verbs.
   */
  request(method: string, params?: unknown, timeoutMs = 60000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.killed || !this.child) {
        reject(new Error('Claude process is not running'));
        return;
      }

      switch (method) {
        case 'initialize': {
          // Claude's own capabilities, stated up front rather than negotiated:
          // the wire has no initialize handshake. `loadSession: false` — Claude
          // session RESTORE is not supported yet, so the manager must NEVER
          // attempt session/resume on the claude path. Every boot is a fresh
          // session (the manager injects a fresh --session-id, never --resume).
          // Re-enable (loadSession:true here + --resume injection in the manager)
          // together, only once restore actually works.
          resolve({
            agentCapabilities: {
              // EXPERIMENT 2026-08-03 (uncommitted): true again, paired with
              // --resume injection in the manager. See the rationale there.
              loadSession: true,
              promptCapabilities: { image: true, embeddedContext: true },
            },
            agentInfo: { name: 'Claude Code' },
          });
          return;
        }

        case 'session/new':
        case 'session/resume': {
          // Acknowledgments, not actions. The session was decided by the args
          // this process was spawned with; there is no way to switch sessions
          // on a live child.
          const requested = (params as SessionResumeParams | undefined)?.sessionId;
          const sessionId = this.spawnSessionId || this.mapper.getSessionId();
          if (requested && sessionId && requested !== sessionId) {
            // Loud, because it means the spawn args and the manager's intent
            // disagree: the manager believes it resumed `requested`, but the
            // child is actually running `sessionId`.
            console.warn(
              `[claude stream-json] ${method} asked for session ${requested} but the child was spawned with ${sessionId}; returning the spawned one`,
            );
          }
          resolve({ sessionId });
          return;
        }

        case 'session/prompt': {
          const prompt = (params as SessionPromptParams | undefined)?.prompt;
          const text = promptText(prompt);
          const imageCount = Array.isArray(prompt)
            ? prompt.filter((block) => block.type === 'image').length
            : 0;
          if (imageCount > 0) {
            // OPEN QUESTION (WO-G4): encodeUserTurn is text-only. Claude's
            // stream-json input accepts image content blocks, but that shape is
            // unverified here, so images are dropped rather than guessed at —
            // note the initialize result above still advertises image support.
            console.warn(
              `[claude stream-json] dropping ${imageCount} image block(s) from session/prompt: image input is not implemented yet`,
            );
          }
          if (!text) {
            reject(new Error('session/prompt carried no text content'));
            return;
          }
          if (this.pendingTurn) {
            // One turn at a time on one process, same as the manager's own
            // single-flight rule. Overlapping turns would interleave on stdin.
            reject(new Error('Claude turn already in flight'));
            return;
          }

          console.log(`[claude stream-json] >>> turn (${text.length} chars)`);
          const pending: PendingTurn = { resolve, reject };
          this.pendingTurn = pending;
          this.write(encodeUserTurn(text));

          if (timeoutMs <= 0) return;

          // Same safety valve as AcpProcess: streaming callers pass
          // timeoutMs=0 and rely on the AcpRuntimeManager watchdog instead.
          pending.timer = setTimeout(() => {
            if (this.pendingTurn !== pending) return;
            this.pendingTurn = null;
            console.warn('[claude stream-json] turn timed out; terminating runtime');
            reject(new Error('Claude turn timed out'));
            this.kill('SIGTERM');
            // Guarantee the process is gone even if SIGTERM is ignored (Windows).
            setTimeout(() => this.forceKill(), 3000);
          }, timeoutMs);
          return;
        }

        case 'session/cancel': {
          this.cancelActiveTurn();
          resolve({});
          return;
        }

        default: {
          // session/set_mode, session/select_model and friends have no
          // stream-json equivalent on a live child (mode and model are spawn
          // flags). Resolving empty keeps the manager's optional calls from
          // failing the runtime; it is an acknowledgment, not an action.
          console.log(`[claude stream-json] ignoring unsupported request ${method}`);
          resolve({});
          return;
        }
      }
    });
  }

  /**
   * OPEN QUESTION (WO-G4): the ACP notification surface — permission
   * responses, control requests — has no stream-json counterpart yet, so
   * everything except cancel is deliberately dropped rather than guessed at.
   *
   * `session/cancel` is honored because the manager's live cancel paths (the
   * prompt watchdog and the human-reply backstop) send it as a NOTIFY, not a
   * request; dropping it would leave a wedged turn spinning forever.
   */
  notify(method: string, _params?: unknown): void {
    if (method === 'session/cancel') {
      this.cancelActiveTurn();
      return;
    }
    console.log(`[claude stream-json] ignoring notification ${method}`);
  }

  /**
   * OPEN QUESTION (WO-G4): responses to agent→client requests (permission
   * prompts above all). Claude's stream-json emits no such requests on the
   * paths exercised so far — it applies its own permission mode from the spawn
   * flags — so there is nothing to answer. No-op until a real control request
   * is observed on the wire; inventing a reply shape here would be fiction.
   */
  respond(id: number | string, _result: unknown): void {
    console.log(`[claude stream-json] ignoring respond for id=${String(id)}`);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.killed = true;
    this.failTurn(new Error('Claude process killed'));
    if (!this.child || this.child.killed) {
      this.child = null;
      return;
    }
    try {
      this.child.kill(signal);
    } catch (err) {
      console.warn(`[claude stream-json] kill(${signal}) failed:`, err);
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
    console.warn(`[claude stream-json] escalating to force kill (pid=${this.child.pid ?? 'unknown'})`);
    try {
      this.child.kill('SIGKILL');
    } catch {
      // ignore
    }
    if (process.platform === 'win32' && this.child.pid) {
      setTimeout(() => {
        if (!this.child || this.child.killed) return;
        if (this.child.exitCode !== null || this.child.signalCode !== null) return;
        console.warn(`[claude stream-json] using taskkill /F /T for pid=${this.child.pid}`);
        try {
          spawn('taskkill', ['/F', '/T', '/PID', String(this.child.pid)], { windowsHide: true, detached: true });
        } catch {
          // ignore
        }
      }, 1500);
    }
  }

  /**
   * End the active turn the way the client asked for (ESC / watchdog).
   *
   * `claude -p` has no cancel verb on stdin, so the only way to stop a turn
   * mid-stream is to kill the child — which means NO `result` ever arrives and
   * the pane would keep an active turn forever. `cancelTurn()` supplies the
   * missing turn boundary (keeping the partial text already streamed), then we
   * settle the promise and kill. Order matters: settling before the kill stops
   * the exit handler from rewriting a deliberate cancel into a process error.
   */
  private cancelActiveTurn(): void {
    console.log('[claude stream-json] cancelling active turn (kills the child; -p has no cancel verb)');
    this.emitUpdates(this.mapper.cancelTurn());
    this.settleTurn({ stopReason: 'cancelled' });
    this.kill('SIGTERM');
  }

  private onStdoutData(chunk: string): void {
    for (const event of this.splitter.push(chunk)) {
      this.handleEvent(event);
    }
  }

  private handleEvent(event: ClaudeStreamJsonEvent): void {
    this.emitUpdates(this.mapper.map(event));

    // `result` is the turn boundary — the closest thing the wire has to a
    // response for session/prompt. Settle AFTER the updates so the pane sees
    // turn_complete before the manager acts on the resolve.
    //
    // The stopReason MUST match the one ClaudeStreamJsonMapper just put on its
    // own turn_complete (same fallbacks as mapResult): the manager emits a
    // SECOND turn_complete built from this resolve value, and two different
    // stop reasons for one turn would leave a failed turn reading `end_turn`.
    // A failed turn still RESOLVES — the error text already reached the pane
    // as an `error` update, and a rejection here would read as a transport
    // failure and trigger a restart.
    if (event.type === 'result') {
      const errored = event.is_error === true || event.subtype === 'error';
      const stopReason = String(event.stop_reason ?? (errored ? 'error' : 'end_turn'));
      this.settleTurn({ stopReason });
    }
  }

  private emitUpdates(updates: AcpSessionUpdate[]): void {
    for (const update of updates) {
      // NOT 'notification': these are already-mapped ACP updates, and the
      // manager must forward them as-is rather than re-map them.
      this.emit('sessionUpdate', this.withSessionId(update));
    }
  }

  /**
   * Stamp the spawn-time session id onto an update the mapper could not label.
   *
   * The mapper learns the session id FROM the wire, so anything emitted before
   * Claude's first event carries `sessionId: ''` — most importantly a cancel
   * of a turn that was killed before it produced output. An update the
   * renderer cannot key to a session never settles that session's turn, which
   * is the exact spinner hang `cancelTurn()` exists to prevent. The spawn args
   * are authoritative, so fill the gap.
   */
  private withSessionId(update: AcpSessionUpdate): AcpSessionUpdate {
    if (!this.spawnSessionId) return update;
    if (update.sessionId) return update;
    return { ...update, sessionId: this.spawnSessionId };
  }

  private settleTurn(result: unknown): void {
    const pending = this.pendingTurn;
    if (!pending) return;
    this.pendingTurn = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(result);
  }

  private failTurn(err: Error): void {
    const pending = this.pendingTurn;
    if (!pending) return;
    this.pendingTurn = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(err);
  }

  /** Queue one NDJSON line for the child's stdin. */
  private write(line: string): void {
    this.writeQueue.push(line);
    this.drainWriteQueue();
  }

  private drainWriteQueue(): void {
    if (this.writePending || !this.child?.stdin || this.child.stdin.destroyed) return;
    const line = this.writeQueue.shift();
    if (!line) return;
    if (!this.child.stdin.writable) {
      this.emit('error', new Error('Claude process stdin is not writable'));
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
}
