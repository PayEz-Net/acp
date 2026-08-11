/**
 * BRIDGE 1 (kanban 117423 / WO-G4): Claude stream-json transport.
 *
 * Runs ONE long-lived Claude process in structured mode —
 *
 *   claude -p --output-format stream-json --input-format stream-json \
 *          --verbose --include-partial-messages
 *
 * — serves it turns as NDJSON on stdin, and persists EVERY event it emits to
 * the bridge event store as it arrives. This is the observability source of
 * truth that replaces PTY-scrape: turn boundaries, tool calls, tool results,
 * usage and errors land on disk within the same tick, and survive the pane
 * (or the whole app) being killed.
 *
 * Scope notes:
 * - This class is ADDITIVE. It does not touch the PTY path and does not flip
 *   `supportsAcp`; wiring it into `AcpRuntimeManager` for a live pane is the
 *   WO-G4 acceptance-bar leg, not this card.
 * - Spawn env ALWAYS goes through `parentEnvWithoutClaudeMarkers()` — an
 *   inherited `CLAUDE_CODE_CHILD_SESSION` makes the child a sub-session
 *   (transcript suppression was diagnosed from that on 2026-07-29; keep the
 *   strip even though `-p` mode on 2.1.227 happens not to suppress).
 * - `cwd` must be STABLE per pane: Claude writes transcripts under a
 *   cwd-derived project slug, so a drifting cwd fragments `--resume` lookups.
 * - Resume: `system/init` and `result` both carry `session_id` (wire-verified
 *   2026-08-11). The bridge surfaces it via `getSessionId()` / the `session`
 *   event; the CALLER persists it (AcpRuntimeManager's acpSessionIds store)
 *   and hands it back as `resumeSessionId` on the next spawn.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import {
  CLAUDE_STREAM_JSON_ARGS,
  NdjsonSplitter,
  encodeUserTurn,
  type ClaudeStreamJsonEvent,
} from './claudeStreamJson';
import { parentEnvWithoutClaudeMarkers } from '../claudeEnvMarkers';
import { appendBridgeEvent } from './bridgeEventStore';

export interface ClaudeStreamJsonBridgeOptions {
  agentName: string;
  /** Stable per-pane working directory (see header — resume depends on it). */
  workDir: string;
  /** Base dir for the event store, e.g. <userData>/bridge-events. */
  eventStoreDir: string;
  /** Claude session id to resume (`--resume <id>`), if the caller has one. */
  resumeSessionId?: string | null;
  /** Command override for tests (default 'claude'). */
  command?: string;
  /** Args prepended before the stream-json flags (tests inject a fixture). */
  commandArgsPrefix?: string[];
}

export class ClaudeStreamJsonBridge extends EventEmitter {
  private child: ChildProcess | null = null;
  private readonly splitter = new NdjsonSplitter();
  private sessionId: string | null;
  private killed = false;

  constructor(private readonly options: ClaudeStreamJsonBridgeOptions) {
    super();
    this.sessionId = options.resumeSessionId ?? null;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.child) return;
    const args = [
      ...(this.options.commandArgsPrefix ?? []),
      ...CLAUDE_STREAM_JSON_ARGS,
      ...(this.sessionId ? ['--resume', this.sessionId] : []),
    ];
    const child = spawn(this.options.command ?? 'claude', args, {
      cwd: this.options.workDir,
      env: parentEnvWithoutClaudeMarkers(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.emit('stderr', chunk));
    child.on('error', (err) => this.emit('error', err));
    child.on('exit', (code, signal) => {
      this.child = null;
      this.emit('exit', code, signal);
    });
  }

  /** Queue one user turn. Throws if the process is not running. */
  prompt(text: string): void {
    if (!this.child?.stdin?.writable) {
      throw new Error(`[Bridge ${this.options.agentName}] prompt on a dead bridge`);
    }
    this.child.stdin.write(encodeUserTurn(text));
  }

  /**
   * Kill the bridge without orphaning the tree. Claude spawns helpers, and a
   * bare child.kill() on Windows leaves them — pty.ts treeKillPty documents
   * the same lesson for the PTY path (`taskkill /T` reaps; not a job object).
   */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    const child = this.child;
    if (!child) return;
    if (process.platform === 'win32' && child.pid) {
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { timeout: 5000, stdio: 'ignore' });
        return;
      } catch { /* already dead or taskkill failed — fall through to kill() */ }
    }
    try {
      child.kill();
    } catch { /* already dead */ }
  }

  private onStdout(chunk: string): void {
    for (const event of this.splitter.push(chunk)) {
      this.captureSessionId(event);
      // Persist BEFORE emitting: a synchronous listener that throws must never
      // cost us the durable record of what the agent actually did.
      appendBridgeEvent(this.options.eventStoreDir, this.options.agentName, this.sessionId, event);
      this.emit('event', event);
    }
  }

  private captureSessionId(event: ClaudeStreamJsonEvent): void {
    const id = event.session_id;
    if (typeof id !== 'string' || !id || id === this.sessionId) return;
    if (event.type === 'system' || event.type === 'result') {
      this.sessionId = id;
      this.emit('session', id);
    }
  }
}
