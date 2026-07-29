import { ipcMain, BrowserWindow, app } from 'electron';
import { execSync } from 'child_process';
import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import {
  IPC_CHANNELS,
  type NoTeamEngagedPayload,
  type SpawnFailedPayload,
  type TerminalProvider,
  type ClaudeEffort as SharedClaudeEffort,
} from '../shared/types';
import {
  type AcpEventPayload,
  type AcpPromptPayload,
  type AcpInjectMailPayload,
  type AcpCancelPayload,
  type AcpPurgeQueuePayload,
  type AcpSetModePayload,
  type AcpKillPayload,
  type AcpPermissionResponsePayload,
} from '../shared/acpTypes';
import { getSettings } from './store';
import { reportPtyOutput, flushPtyOutput, dropPtyOutput } from './ptyOutputReporter';
import { AcpRuntimeManager } from './acp/AcpRuntimeManager';
import { getProviderConfig, resolveKimiModelAlias } from './acp/providerConfigs';
import { buildClaudeSpawnCommand, resolveClaudeEffort } from './claudeSpawnCommand';
import { deriveClaudeSessionId, claudeSessionExists } from './claudeSession';
import { buildAgentBootPrompt } from './acp/bootPrompt';
import { startAgentSession, endAgentSession } from './agentSessionLifecycle';
import { TerminalScreen } from './terminalScreen';

// Per-terminal screen models (see terminalScreen.ts). Raw PTY bytes are fed
// through a logical screen so repaint sequences (resize, spinner, \r redraws)
// reach the renderer as frame updates instead of append-only fragments.
const terminalScreens = new Map<string, TerminalScreen>();
const frameFlushTimers = new Map<string, NodeJS.Timeout>();
const FRAME_FLUSH_MS = 40;

function flushTerminalFrame(terminalId: string): void {
  const timer = frameFlushTimers.get(terminalId);
  if (timer) {
    clearTimeout(timer);
    frameFlushTimers.delete(terminalId);
  }
  const screen = terminalScreens.get(terminalId);
  if (!screen) return;
  const update = screen.takeUpdate();
  if (!update) return;
  safeSend(IPC_CHANNELS.TERMINAL_FRAME, update);
  if (update.historyAppended.length > 0) {
    reportTerminalRows(terminalId, update.historyAppended);
  }
}

/** Post finalized rows to the cloud output record.
 *
 *  Rows are reported ONLY once they have left the visible screen (or on
 *  teardown, via disposeTerminalScreen). This is the whole point: the previous
 *  path posted every raw `onData` chunk, so an in-place repaint — a spinner
 *  tick, a pi-tui full-frame redraw behind ESC[2J ESC[H — became one POST per
 *  animation frame. With 8 agents that saturated vibe-api into `no healthy
 *  upstream` (503), and ptyOutputReporter then discarded each payload after 5
 *  retries: garbled panes, burned CPU, and silent output loss from one cause.
 *  TerminalScreen resolves the cursor addressing first; only settled lines are
 *  sent. */
function reportTerminalRows(terminalId: string, rows: string[]): void {
  const managed = terminals.get(terminalId);
  if (!managed) return;

  // Split on ROW boundaries so one busy frame never becomes an unbounded POST
  // body. Reporting settled batches instead of raw chunks collapsed POST COUNT
  // but made POST SIZE unbounded — `MAX_BUFFER_BYTES` in the reporter only
  // guards its accumulator, and a single call arriving pre-batched bypasses it.
  // Observed 114KB bodies failing with cause=network before this cap. Never
  // split mid-row: a partial line is corrupt content, not a smaller payload.
  const MAX_REPORT_BYTES = 8192;
  const send = (batch: string[]) => {
    if (batch.length === 0) return;
    reportPtyOutput(
      managed.agentName,
      terminalId,
      batch.join('\n') + '\n',
      managed.provider,
      managed.projectId ? String(managed.projectId) : undefined,
      undefined,
      managed.sessionToken,
    );
  };

  let batch: string[] = [];
  let size = 0;
  for (const row of rows) {
    // A single row wider than the cap still goes alone — splitting it would
    // corrupt the line, and the reporter handles an oversized body better than
    // the replay handles a severed one.
    if (batch.length > 0 && size + row.length + 1 > MAX_REPORT_BYTES) {
      send(batch);
      batch = [];
      size = 0;
    }
    batch.push(row);
    size += row.length + 1;
  }
  send(batch);
}

function scheduleTerminalFrameFlush(terminalId: string): void {
  if (frameFlushTimers.has(terminalId)) return;
  frameFlushTimers.set(
    terminalId,
    setTimeout(() => flushTerminalFrame(terminalId), FRAME_FLUSH_MS),
  );
}

function disposeTerminalScreen(terminalId: string): void {
  // Drains and reports any rows that had already scrolled off.
  flushTerminalFrame(terminalId);
  // Rows still on the visible screen never scroll into `historyAppended`, so
  // without this the final screenful of every session is missing from the
  // stored record. Must run before `terminals.delete(terminalId)` — the
  // reporter reads agentName/provider/sessionToken from the ManagedPty.
  const screen = terminalScreens.get(terminalId);
  if (screen) {
    const finalRows = screen.snapshot();
    if (finalRows.length > 0) reportTerminalRows(terminalId, finalRows);
  }
  terminalScreens.delete(terminalId);
}


interface ManagedPty {
  id: string;
  agentName: string;
  // Project scope — prevents multi-project name collisions (P0 namespace fix).
  // Undefined for legacy renderer-driven spawns until the caller is updated.
  projectId: number | undefined;
  // The runtime/provider this terminal was actually LAUNCHED with
  // (SPEC-team-runtime §3.2). Recorded at spawn so the reattach (409) path
  // can compare a live terminal's provider against the requested team
  // runtime and restart-to-conform instead of returning a stale one. This
  // is the field that catches "agent is up, but on the wrong CLI."
  provider: TerminalProvider;
  pty: pty.IPty;
  // Whether Claude Code has enabled bracketed paste mode via ESC[?2004h
  // on this PTY's output stream. Kept as a diagnostic only — we no
  // longer wrestle PTY bytes for mail push (that's handled by the MCP
  // Channels path in acp-mail-channel.js).
  bracketedPasteEnabled: boolean;
  // Handle for the Kimi/Codex inbox poller. Claude agents use the MCP
  // channel server (acp-mail-channel.js) instead and leave this null.
  mailPollTimer: NodeJS.Timeout | null;
  // Path to the boot-prompt tmp file passed via --system-prompt-file (Claude)
  // or kept for reference when PTY-injected (Kimi/Codex). Cleaned up on
  // PTY exit. Null when no boot-prompt was provided (legacy 4-pane mode
  // or the orchestrator passed bootPrompt:null).
  bootPromptTmpPath: string | null;
  // Paced-write FIFO state (paste-truncation fix). A single large
  // pty.write() of a paste overruns the Windows ConPTY console-input
  // buffer faster than the child TUI drains stdin → overflow bytes are
  // silently dropped ("paste appears truncated, and is"). writeBuf holds
  // the not-yet-flushed input; writeDraining guards the drain loop so
  // byte order is preserved across interleaved writes (typing while a
  // paste drains). See queuePtyWrite/drainPtyWrite.
  writeBuf: string;
  writeDraining: boolean;
  // PayEzVibe agent session token for the active session; used to authorize
  // agent-output POSTs without relying on name/id resolution.
  sessionToken?: string;
  /**
   * Set when this PTY is being torn down ON PURPOSE (kill, restart, project
   * teardown). The `onExit` handler cannot distinguish a crash from a deliberate
   * kill by exit code alone — a tree-kill exits non-zero exactly like a crash —
   * so intent has to be recorded here BEFORE the process dies and passed to the
   * exit report. Undefined = a genuine unexpected exit, i.e. a real crash.
   */
  intentionalExit?: import('./agentSessionLifecycle').AgentSessionEndReason;
}

export type AgentRuntime = TerminalProvider;

/**
 * Re-exported from shared/types so main-process callers keep importing
 * `ClaudeEffort` from here. The union itself lives in ONE place now
 * (CLAUDE_EFFORTS) — this was a hand-written duplicate missing 'xhigh'.
 */
export type ClaudeEffort = SharedClaudeEffort;

export interface SpawnAgentOptions {
  /** Wave D assembled system prompt from `/v1/projects/:id/boot-prompt/:agent_id`.
   *  When provided, replaces the legacy "report as <Agent>" kickoff: Claude
   *  receives it via `--system-prompt-file <file>`; Kimi/Codex receive it via
   *  PTY-injection after banner (until those CLIs add a --system-prompt
   *  flag — code-commented in the spawn paths). */
  bootPrompt?: string;
  /** The team runtime for a project-scoped spawn — the SINGLE authority
   *  (SPEC-team-runtime §3.1/§3.3). The renderer/orchestrator resolves it
   *  from `activeProject.runtime_choice` and threads it here. It is NOT a
   *  mere "override" of the global: on a project-scoped spawn (projectId
   *  set) the global `settings.agentProvider` never applies, and an absent
   *  runtime is a hard-stop (RuntimeNotSetError), not a fall-back to the
   *  global. The global is the default ONLY on the no-active-project /
   *  legacy-IPC path (projectId absent). Per-member mixed runtimes are
   *  parked (§5) — runtime is team-uniform. */
  runtime?: AgentRuntime;
  /** Per-agent effort override (Claude `--effort`; k3 thinking effort via
   *  KIMI_MODEL_THINKING_EFFORT env — WO-KIMI-MODEL-OVERRIDE), consumed at spawn.
   *  Leg (b) of effort_override consumption (Aurum 1405):
   *  the spawn resolver defers to ONE chain —
   *    per-agent override -> single global default (settings.claudeEffort) -> 'high'.
   *  undefined = inherit (NOT a DB-baked literal; the effort_override column
   *  has no DEFAULT, so NULL round-trips as "defer to the resolver"). The
   *  renderer/orchestrator reads team_agent_instances.effort_override (the
   *  engaged standing team's per-placement override — live-team model; same
   *  path as `runtime`) and threads it here — leg (a), NextPert. Codex has
   *  no effort lever, so this is ignored for codex. */
  effort?: ClaudeEffort;
  /** Bare kimi model id from team_agent_instances.model_override
   *  (WO-KIMI-MODEL-OVERRIDE) — `k3` | `kimi-for-coding` |
   *  `kimi-for-coding-highspeed`. undefined/null = inherit default_model.
   *  Passed through RAW (never narrowed upstream): unknown/mistyped ids
   *  must fail loud at the spawn boundary (ModelNotRecognizedError), not be
   *  stripped into a silent inherit — that fallback is explicitly
   *  unacceptable per the WO's locked decisions. */
  modelOverride?: string;
  /** Project ID for namespace scoping. Prevents multi-project PTY
   *  collisions when two projects share agent names. */
  projectId?: number;
  /** Numeric agent id from the project team table. Required to start a
   *  PayEzVibe agent session while this terminal/runtime is alive. */
  agentId?: number;
}

const terminals: Map<string, ManagedPty> = new Map();
const acpRuntimes: Map<string, AcpRuntimeManager> = new Map();
let mainWindowRef: BrowserWindow | null = null;

function getAcpRuntimeByAgent(agentName: string): AcpRuntimeManager | undefined {
  for (const runtime of acpRuntimes.values()) {
    if (runtime.getAgentName() === agentName) return runtime;
  }
  return undefined;
}

export interface AgentSessionInfo {
  id: string;
  agentName: string;
  projectId?: number;
  provider: AgentRuntime;
  kind: 'pty' | 'acp';
}

/**
 * Find any live session for an agent, checking both node-pty terminals and
 * structured ACP runtimes. This prevents duplicate spawns when an agent is
 * already running in ACP mode but has no PTY entry.
 */
export function getAgentSessionByAgent(agentName: string, projectId?: number): AgentSessionInfo | undefined {
  for (const t of terminals.values()) {
    if (t.agentName === agentName) {
      if (projectId == null || t.projectId === projectId) {
        return { id: t.id, agentName: t.agentName, projectId: t.projectId, provider: t.provider, kind: 'pty' };
      }
    }
  }
  for (const [id, runtime] of acpRuntimes.entries()) {
    if (runtime.getAgentName() === agentName) {
      if (projectId == null || runtime.getProjectId() === projectId) {
        return { id, agentName: runtime.getAgentName(), projectId: runtime.getProjectId(), provider: runtime.getProvider(), kind: 'acp' };
      }
    }
  }
  return undefined;
}

// ESC [ ? 2 0 0 4 h  — DECSET, enable bracketed paste
const BRACKETED_PASTE_ON = Buffer.from([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x68]);
// ESC [ ? 2 0 0 4 l  — DECRST, disable bracketed paste
const BRACKETED_PASTE_OFF = Buffer.from([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x6c]);

// --- Paced PTY input writer (paste-truncation fix) -----------------------
// Symptom: pasting a multi-line block into an agent terminal arrives truncated
// mid-content — bytes are actually missing (e.g. a 64-line DDL clipped at
// ~line 27 ≈ 1 KB).
//
// MISDIAGNOSIS we corrected (measured 2026-06-17 via an isolated node-pty
// repro into a byte-counting child): it is NOT a ConPTY console-input-buffer
// overflow at normal paste sizes. A single pty.write() of up to ~24 KB is
// delivered LOSSLESSLY through ConPTY even to a deliberately slow-draining
// child. So a few-KB paste never needed splitting.
//
// REAL cause: the prior fix split EVERY paste into 1 KB writes. That fragments
// the bracketed-paste sequence (ESC[200~ … ESC[201~) across multiple writes,
// and the child TUI's (Claude Code) paste parser finalizes on the FIRST
// fragment and drops the remainder → truncation lands exactly at the first
// chunk boundary (~1 KB), matching the reported "line 27 of 64". The chunking
// meant to help ConPTY was actively CAUSING the truncation on normal pastes.
//
// Fix: keep normal pastes in ONE write so the bracketed paste arrives intact.
// Raise the single-write threshold to 16 KB (proven ConPTY-safe even to a slow
// child). Only genuinely huge pastes (>16 KB) are chunked+paced — far rarer,
// and at 16 KB they fragment 16× less than the old 1 KB. A per-PTY FIFO
// (writeBuf) preserves byte order across interleaved writes; single keystrokes
// take the immediate fast path so normal typing has ZERO added latency.
const PTY_WRITE_CHUNK = 16384;  // bytes per write — normal pastes go in ONE write (intact bracketed paste); ConPTY-safe to ~24 KB
const PTY_WRITE_PACE_MS = 4;    // gap between chunks; only applies to >16 KB pastes

function queuePtyWrite(managed: ManagedPty, data: string): void {
  if (!data) return;
  managed.writeBuf += data;
  if (!managed.writeDraining) drainPtyWrite(managed);
}

/**
 * Inject a code-generated boot prompt into a PTY as a single pasted input.
 * Multi-line prompts would otherwise be split at embedded newlines and
 * interpreted as multiple commands; bracketed paste lets the receiving CLI
 * consume the whole block as one user message.
 */
function injectBootPrompt(managed: ManagedPty, bootPrompt: string): void {
  if (!bootPrompt) return;
  if (bootPrompt.length > PTY_WRITE_CHUNK) {
    console.warn(`[PTY] Boot prompt for ${managed.agentName} is ${bootPrompt.length} chars (> ${PTY_WRITE_CHUNK}); chunked paste may not land cleanly`);
  }
  const paste = `\x1b[200~${bootPrompt}\x1b[201~\r`;
  queuePtyWrite(managed, paste);
}

function drainPtyWrite(managed: ManagedPty): void {
  // Fast path: anything that fits in one chunk (every keystroke, most
  // commands) flushes immediately with no pacing delay.
  if (managed.writeBuf.length <= PTY_WRITE_CHUNK) {
    if (managed.writeBuf) {
      managed.pty.write(managed.writeBuf);
      managed.writeBuf = '';
    }
    managed.writeDraining = false;
    return;
  }
  managed.writeDraining = true;
  // Never split a UTF-16 surrogate pair across a chunk boundary — node-pty
  // re-encodes the string to UTF-8 and a halved emoji/codepoint would
  // corrupt. If the boundary char is a high surrogate, defer it to the
  // next chunk so its low surrogate stays attached.
  let end = PTY_WRITE_CHUNK;
  const boundary = managed.writeBuf.charCodeAt(end - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) end -= 1;
  const chunk = managed.writeBuf.slice(0, end);
  managed.writeBuf = managed.writeBuf.slice(end);
  managed.pty.write(chunk);
  setTimeout(() => drainPtyWrite(managed), PTY_WRITE_PACE_MS);
}

function safeSend(channel: string, ...args: unknown[]): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed() && !mainWindowRef.webContents.isDestroyed()) {
    mainWindowRef.webContents.send(channel, ...args);
  }
}

/**
 * Emit a typed spawn-failure to the renderer (SPEC-workdir-invalid §3.4,
 * orchestrator-path parity). The spawn-orchestrator calls spawnAgent
 * DIRECTLY with no renderer fetch to catch the throw — so a WorkDirError
 * there is orphaned main-side unless we push it out. Routes through the
 * same safeSend/mainWindowRef authority that already carries every other
 * PTY_* event (one window ref, not a second BrowserWindow lookup). The
 * renderer dedups by project and renders one actionable surface.
 */
export function emitSpawnFailed(payload: SpawnFailedPayload): void {
  safeSend(IPC_CHANNELS.PTY_SPAWN_FAILED, payload);
}

/**
 * Emit the no-team-engaged abort to the renderer (WO-ACP-LIVE-TEAM-MERGE
 * ACP-2). Under the live-team model an empty roster is the DEFAULT for
 * fresh projects (no standing team engaged — 200, not an error), so the
 * orchestrator's spawn abort must surface as a renderer-visible "pick a
 * team" CTA, not just a console.warn. Same safeSend authority as
 * emitSpawnFailed above.
 */
export function emitNoTeamEngaged(payload: NoTeamEngagedPayload): void {
  safeSend(IPC_CHANNELS.PROJECT_NO_TEAM_ENGAGED, payload);
}

// Exit callback — set by lifecycle-server to report PTY exits to acp-api
let onPtyExit:
  | ((
      agentName: string,
      terminalId: string,
      exitCode: number,
      /** Absent = genuine crash. Present = we killed it on purpose. */
      reason?: import('./agentSessionLifecycle').AgentSessionEndReason,
    ) => void)
  | null = null;

export function setOnPtyExit(callback: typeof onPtyExit) {
  onPtyExit = callback;
}

function getAcpBinDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin');
  }
  return path.join(app.getAppPath(), 'resources', 'bin');
}

// --- Kimi/Codex mail poller ---------------------------------------------
// Claude Code has MCP channels for out-of-band push (acp-mail-channel.js).
// Kimi and Codex have MCP server support but no channels, so we poll the
// inbox HTTP endpoint and inject a one-line user message into the PTY
// stdin when new unread mail arrives. The first poll's backlog is
// recorded without firing so a session starting into N old unread mails
// doesn't firehose the agent with N simultaneous injections.

const MAIL_POLL_INTERVAL_MS = 30000;
const MAIL_POLL_JITTER_MAX_MS = 10000;
const MAIL_POLL_BACKOFF_MAX_MS = 300000; // 5 min cap

function fetchUnreadInbox(agentName: string, projectId?: number): Promise<{ response: any; statusCode?: number }> {
  return new Promise((resolve) => {
    const apiBase = process.env.ACP_API_URL || 'http://127.0.0.1:3001';
    const u = new URL(`/v1/mail/inbox/${encodeURIComponent(agentName)}`, apiBase);
    u.searchParams.set('unread', 'true');
    u.searchParams.set('pageSize', '50');
    if (projectId != null) {
      u.searchParams.set('project_id', String(projectId));
    }

    const req = http.get(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        headers: { 'X-ACP-Agent': agentName, 'Accept': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return resolve({ response: null, statusCode: res.statusCode ?? undefined });
          }
          try { resolve({ response: JSON.parse(body), statusCode: 200 }); } catch { resolve({ response: null, statusCode: res.statusCode ?? undefined }); }
        });
      }
    );
    req.on('error', () => resolve({ response: null }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ response: null }); });
  });
}

function extractMessages(response: any): any[] {
  if (!response) return [];
  const d = response.data ?? response;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.messages)) return d.messages;
  if (Array.isArray(d?.inbox)) return d.inbox;
  if (Array.isArray(d?.rows)) return d.rows;
  return [];
}

function startInboxPoller(managed: ManagedPty): void {
  const { agentName, projectId } = managed;
  const seen = new Set<number>();
  let firstPoll = true;
  const apiBase = process.env.ACP_API_URL || 'http://127.0.0.1:3001';
  let currentInterval = MAIL_POLL_INTERVAL_MS + Math.floor(Math.random() * MAIL_POLL_JITTER_MAX_MS);
  let consecutive429s = 0;
  let activeTimer: NodeJS.Timeout | null = null;

  const scheduleNext = () => {
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = setTimeout(poll, currentInterval);
    managed.mailPollTimer = activeTimer;
  };

  const poll = async () => {
    const { response, statusCode } = await fetchUnreadInbox(agentName, projectId);

    // Back off on 429 so we don't DDoS the local API when many agents run.
    if (statusCode === 429) {
      consecutive429s++;
      currentInterval = Math.min(
        currentInterval * 2,
        MAIL_POLL_BACKOFF_MAX_MS
      );
      console.warn(`[PTY] Mail poll 429 for ${agentName}, backing off to ${currentInterval}ms (streak: ${consecutive429s})`);
      scheduleNext();
      return;
    }

    if (statusCode !== 200) {
      // Non-429 error — keep current interval but don't reset backoff entirely
      scheduleNext();
      return;
    }

    // Success — gradually restore interval
    consecutive429s = Math.max(0, consecutive429s - 1);
    if (consecutive429s === 0 && currentInterval > MAIL_POLL_INTERVAL_MS) {
      currentInterval = Math.max(MAIL_POLL_INTERVAL_MS, Math.floor(currentInterval / 2));
    }

    const messages = extractMessages(response);
    if (firstPoll) {
      for (const m of messages) {
        const id = m.message_id ?? m.id;
        if (id != null) seen.add(Number(id));
      }
      firstPoll = false;
      scheduleNext();
      return;
    }

    for (const m of messages) {
      const id = m.message_id ?? m.id;
      if (id == null || seen.has(Number(id))) continue;
      seen.add(Number(id));
      const from = m.from_agent ?? 'unknown';
      const subject = m.subject ?? '(no subject)';
      const text =
        `[ACP Mail] New message from ${from}: "${subject}" (id ${id}). ` +
        `Read it NOW with: curl -s ${apiBase}/v1/mail/messages/${id} -H "X-ACP-Agent: ${agentName}" ` +
        `and act on actionable messages — do not wait for the human.`;
      // Inject as bracketed paste + a SEPARATE Enter write. A raw
      // `write(text + '\r')` arrives as one input burst; the kimi TUI treats
      // the burst as pasted content and the trailing \r becomes a newline in
      // the draft — the notice sat unsubmitted in the input box until a
      // human pressed Enter. Paste-close followed by a distinct Enter write
      // is processed as a real submit, so mail lands straight in context.
      queuePtyWrite(managed, `\x1b[200~${text}\x1b[201~`);
      setTimeout(() => queuePtyWrite(managed, '\r'), 100);
      console.log(`[PTY] Pushed mail ${id} from ${from} into ${agentName} PTY`);
    }

    scheduleNext();
  };

  // Kick off an initial poll immediately so the seen-set is primed
  // before any new mail arrives (avoids a 3s race on startup).
  poll();
  console.log(`[PTY] Started inbox poller for ${agentName} (base ${MAIL_POLL_INTERVAL_MS}ms, jitter ${MAIL_POLL_JITTER_MAX_MS}ms)`);
}

function writeBootPromptTmpFile(agentName: string, bootPrompt: unknown): string {
  // Guard: never hand writeFileSync a non-string (the cloud boot_prompt
  // came back as an Object → ERR_INVALID_ARG_TYPE crashed every spawn).
  // fetchBootPrompt should extract the string; this is the last-line
  // coercion so a shape surprise can never crash a spawn again.
  const text = typeof bootPrompt === 'string' ? bootPrompt : JSON.stringify(bootPrompt, null, 2);
  // Tmp file location: %APPDATA%/agent-collaboration-platform/tmp/
  // (or platform equivalent) per BAPert msg 1148 Q1 answer. Cleaned up
  // on PTY exit by the onExit handler. Filename includes ts so a
  // re-spawn of the same agent doesn't collide with a still-clearing
  // previous spawn.
  const dir = path.join(app.getPath('userData'), 'tmp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fname = `boot-prompt-${agentName}-${Date.now()}.txt`;
  const filepath = path.join(dir, fname);
  fs.writeFileSync(filepath, text, { encoding: 'utf8' });
  return filepath;
}

function cleanupBootPromptTmpFile(filepath: string | null): void {
  if (!filepath) return;
  try {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch (err) {
    console.warn(`[PTY] Failed to cleanup boot-prompt tmp file ${filepath}:`, err);
  }
}

/**
 * Spawn a PTY for an agent. Returns the terminal UUID.
 * Called by IPC (renderer) or HTTP (lifecycle-server from acp-api) or
 * spawn-orchestrator (Wave C, when lifecycle flips to RUNNING).
 *
 * When `opts.bootPrompt` is provided (Wave C/D), it overrides the
 * legacy "report as <Agent>" kickoff string. Claude takes it via
 * `--system-prompt-file <file>` (full Wave D assembled prompt). Kimi/Codex
 * take a shorter PTY-injected form because those CLIs don't expose a
 * system-prompt flag yet (verify with `kimi --help` / `codex --help`
 * upstream; migrate when the flag lands per `feedback_no_acknowledged_defect_ships`).
 */
/**
 * THE single workspace-root authority (colonization spec v2 §2.1/§2.2).
 * ONE input: the explicit installer-recorded root (project.repo_path, or
 * its known persisted twin settings.installerWorkspaceRoot — the caller
 * supplies whichever; this never re-derives). It exists as a directory or
 * it does not: returns the path, or null. NO `process.cwd()/..` infer
 * backstop — that "last resort" was the hole: in the installed app it
 * resolves to the ...\Programs install folder, which exists, so spawnAgent
 * spawned agents THERE (no repo, no colonized .claude) instead of failing
 * loudly. The value is known (cloud repo_path / handoff json); a missing
 * dir is a surfaced WorkDirError, never a silent wrong-dir. Never compose,
 * never a literal, never infer.
 */
export function resolveWorkDir(explicit?: string): string | null {
  const exp = explicit?.trim();
  if (!exp) return null;
  try {
    return fs.statSync(exp).isDirectory() ? exp : null;
  } catch {
    return null;
  }
}

/**
 * Thrown synchronously by spawnAgent BEFORE node-pty is touched when the
 * resolved working directory does not exist. node-pty throws Win32 267
 * (ERROR_DIRECTORY) ASYNCHRONOUSLY from its pipe-connection callback —
 * uncatchable by try/catch or the ipcMain chain — surfacing as Electron's
 * main-process crash dialog. The only robust fix is to never hand
 * node-pty a bad cwd.
 */
export class WorkDirError extends Error {
  constructor(public readonly agentName: string, public readonly workDir: string) {
    super(
      `Cannot spawn ${agentName}: working directory ${JSON.stringify(workDir)} does not exist on this machine. ` +
      `Colonization resolves the root (single authority) — set a real project repo path.`,
    );
    this.name = 'WorkDirError';
  }
}

/**
 * Thrown synchronously by spawnAgent BEFORE node-pty is touched when an
 * ACTIVE project's spawn arrives with no resolved team runtime
 * (SPEC-team-runtime §3.3, Jon re-scope 2026-06-16). The team runtime
 * (resolveTeamRuntime from the project's runtime_choice) is the SINGLE
 * authority; the machine global agentProvider is NOT a fallback for it. An
 * unset runtime on an active project is a hard-stop, not a license to guess
 * a provider — a warned default is "the same fallback in a hi-vis vest"
 * (feedback_fallback_to_avoid_crash_is_the_hole). team-create guarantees
 * runtime_choice NOT NULL (idealvibe), so this is a defensive assert that
 * surfaces + blocks rather than ever launching a silent claude.
 */
export class RuntimeNotSetError extends Error {
  constructor(public readonly agentName: string, public readonly projectId: number) {
    super(
      projectId >= 0
        ? `Cannot spawn ${agentName}: project ${projectId} has no team runtime set. ` +
          `Choose a team runtime (claude / kimi / codex) for this project before its agents can start.`
        : `Cannot spawn ${agentName}: no team runtime resolved and no active project. ` +
          `The team runtime is required to launch an agent — there is no global default (SPEC-team-runtime §3.3).`,
    );
    this.name = 'RuntimeNotSetError';
  }
}

/**
 * WO#33: durable, packaged/no-terminal-locatable surfacing of a
 * skipped-supplied-workDir. resolveWorkDir's console.warn is main-console
 * only. Best-effort: never throws (must not regress 267-immunity).
 */
function noteWorkDirSkip(agentName: string, requested: string, resolved: string): void {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'workdir-notices.log'),
      `[${new Date().toISOString()}] ${agentName}: requested work dir ${JSON.stringify(requested)} not found — using ${JSON.stringify(resolved)} instead\n`,
      'utf8',
    );
  } catch { /* best-effort; resolveWorkDir's console.warn is the dev copy */ }
}

export function spawnAgent(agentName: string, workDir: string, opts?: SpawnAgentOptions): string {
  // Guard BEFORE allocating any runtime — a non-existent cwd makes node-pty throw
  // Win32 267 asynchronously and crash the main process (see WorkDirError).
  const resolvedWorkDir = resolveWorkDir(workDir);
  if (!resolvedWorkDir) {
    const tried = (workDir && workDir.trim()) || path.resolve(process.cwd(), '..');
    const err = new WorkDirError(agentName, tried);
    console.error(`[PTY] ${err.message}`);
    throw err;
  }
  const requested = workDir?.trim();
  if (requested && requested !== resolvedWorkDir) {
    noteWorkDirSkip(agentName, requested, resolvedWorkDir);
  }

  // Provider resolution (SPEC-team-runtime §3.3 — Jon re-scope: this is THE
  // spine, not a softener). The team runtime (opts.runtime, resolved by the
  // renderer/orchestrator from the active project's runtime_choice) is the
  // SINGLE authority. settings.agentProvider is NO LONGER read on the spawn
  // path (FLAG 6 deleted the only caller that relied on a global guess — the
  // renderer's !backendAvailable IPC fallback now hard-surfaces instead):
  //   • opts.runtime present  -> authoritative, use it.
  //   • opts.runtime absent   -> SURFACE + BLOCK (throw RuntimeNotSetError).
  //                              NEVER guess a provider; a warned 'claude'
  //                              default is the same masking fallback in a
  //                              hi-vis vest (feedback_fallback_to_avoid_
  //                              crash_is_the_hole). projectId is carried for
  //                              the surface; -1 marks a no-active-project
  //                              spawn, which post-FLAG-6 has no legitimate
  //                              caller (defensive — still blocks, never guesses).
  // Resolved BEFORE pty.spawn so the block throws with zero PTY allocated.
  const settings = getSettings();
  let provider: AgentRuntime;
  if (opts?.runtime) {
    provider = opts.runtime;
  } else {
    const err = new RuntimeNotSetError(agentName, opts?.projectId ?? -1);
    console.error(`[PTY] ${err.message}`);
    throw err;
  }
  console.log(`[PTY] Provider for ${agentName}: ${provider} — source: team-runtime`);

  // Data-driven onboarding prompt. Per-agent `.claude/commands/report-*.md`
  // files are gone; the agent receives its onboarding instructions injected
  // directly into its context. A cloud-provided Wave-D boot prompt wins when
  // present; otherwise we synthesize one from code using only the agent name.
  const bootPrompt = opts?.bootPrompt?.trim()
    ? opts.bootPrompt.trim()
    : buildAgentBootPrompt(agentName);

  // ACP path (structured JSON-RPC). Kimi is the Phase 1 ACP provider;
  // Claude/Codex continue to use the PTY fallback below.
  const providerConfig = getProviderConfig(provider);
  if (providerConfig.supportsAcp) {
    const id = crypto.randomUUID();
    console.log(`[ACP] Starting ${agentName} via ACP (${provider}) cwd=${resolvedWorkDir}`);
    const runtime = new AcpRuntimeManager(id, providerConfig, {
      agentName,
      workDir: resolvedWorkDir,
      projectId: opts?.projectId,
      bootPrompt,
      effort: opts?.effort,
      modelOverride: opts?.modelOverride,
      agentId: opts?.agentId,
    });
    // Phase 1: explicit renderer approval is coming later; until then stay
    // conservative and surface permission requests through ACP_EVENT.
    runtime.setAutoApprove(false);
    acpRuntimes.set(id, runtime);
    runtime.on('event', (payload: AcpEventPayload) => {
      safeSend(IPC_CHANNELS.ACP_EVENT, payload);
    });
    // Reuse the PTY_SPAWNED channel so the renderer's agentName→terminalId
    // mapping works the same way for ACP sessions. Include the actual runtime
    // provider so the renderer can resolve mail-injection behavior correctly
    // even when agent.provider is stale.
    safeSend(IPC_CHANNELS.PTY_SPAWNED, { agentName, terminalId: id, provider });
    runtime
      .start()
      .catch((err) => {
        console.error(`[ACP] Runtime failed to start for ${agentName}:`, err);
        safeSend(IPC_CHANNELS.ACP_EVENT, {
          agent: agentName,
          sessionId: runtime.getSessionId() ?? '',
          update: { sessionUpdate: 'error', error: err instanceof Error ? err.message : String(err) },
        });
        void endAgentSession(id, 'normal');
        acpRuntimes.delete(id);
      });
    return id;
  }

  // PTY fallback path for providers that don't support ACP (Claude, Codex).
  const id = crypto.randomUUID();

  // Kimi PTY-fallback model (this branch is unreachable while kimi is
  // supportsAcp:true, but keep it honest): thread modelOverride through the
  // same fail-loud alias authority as the ACP spawn boundary — an unknown id
  // throws here, synchronously, before any PTY is allocated, instead of
  // silently launching the legacy hardcoded default (WO 11489 follow-up).
  const kimiPtyModel =
    provider === 'kimi' && opts?.modelOverride
      ? resolveKimiModelAlias(opts.modelOverride)
      : 'kimi-for-coding-highspeed';
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const acpBinDir = getAcpBinDir();
  const existingPath = process.env.PATH || process.env.Path || '';

  console.log(`[PTY] Spawning ${agentName} shell=${shell} cwd=${resolvedWorkDir}`);

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: resolvedWorkDir,
    env: {
      ...process.env,
      VIBE_AGENT: agentName,
      // ACP_AGENT_NAME is the canonical name the MCP channel server
      // (acp-mail-channel.js) reads to know which agent it's polling
      // mail for. VIBE_AGENT is kept for compatibility with older code.
      ACP_AGENT_NAME: agentName,
      ACP_SURFACE_ID: id,
      ACP_AGENT_ID: `agent:${agentName}`,
      ACP_API_URL: process.env.ACP_API_URL || 'http://localhost:3001',
      ACP_BIN_DIR: acpBinDir,
      PATH: `${acpBinDir}${path.delimiter}${existingPath}`,
    } as Record<string, string>,
  });

  // Write boot-prompt to a tmp file up-front so the spawn command can
  // reference it via --system-prompt-file (Claude) and the orchestrator
  // can clean it up on PTY exit (any runtime).
  const bootPromptTmpPath = bootPrompt
    ? writeBootPromptTmpFile(agentName, bootPrompt)
    : null;

  const managed: ManagedPty = {
    id,
    agentName,
    projectId: opts?.projectId,
    provider,
    pty: ptyProcess,
    bracketedPasteEnabled: false,
    mailPollTimer: null,
    bootPromptTmpPath,
    writeBuf: '',
    writeDraining: false,
  };
  terminals.set(id, managed);
  terminalScreens.set(id, new TerminalScreen(id, agentName, 120, 30));

  if (opts?.agentId != null) {
    void (async () => {
      const result = await startAgentSession(id, opts.agentId!, opts.projectId);
      if (result.ok && result.session.sessionToken) {
        managed.sessionToken = result.session.sessionToken;
      }
      if (!result.ok) {
        // Surface the non-fatal session-start failure in the UI so the user
        // sees why the agent-output stream will fail, instead of a silent
        // console warning. Drop pending PTY output for this terminal so the
        // failed session does not keep POSTing to /v1/agent-output.
        dropPtyOutput(id);
        safeSend(IPC_CHANNELS.AGENT_SESSION_START_FAILED, {
          agentName,
          terminalId: id,
          status: result.status,
          message: result.message,
        });
      }
    })();
  }

  // Tell the renderer this agent now has a live terminal — covers the
  // spawn-orchestrator path (main spawned it; the renderer never called
  // pty:spawn so it has no terminalId and the pane sits idle). Renderer
  // maps agentName→terminalId and binds its UnifiedTerminal surface to the running PTY.
  // Include the actual runtime provider so mail-injection logic uses the real provider.
  safeSend(IPC_CHANNELS.PTY_SPAWNED, { agentName, terminalId: id, provider });

  // Forward PTY output to renderer. Tap the stream just to notice when
  // Claude Code flips bracketed paste mode on/off — purely diagnostic
  // now that mail push is handled by the MCP Channels path.
  ptyProcess.onData((data) => {
    safeSend(IPC_CHANNELS.PTY_DATA, { terminalId: id, data });
    terminalScreens.get(id)?.feed(data);
    scheduleTerminalFrameFlush(id);
    // NOT reported here. Raw chunks carry cursor addressing, so posting them
    // turned every in-place repaint into a stored line and a POST. Reporting
    // happens in flushTerminalFrame once rows settle. See reportTerminalRows.

    const buf = Buffer.from(data);
    if (buf.includes(BRACKETED_PASTE_ON) && !managed.bracketedPasteEnabled) {
      managed.bracketedPasteEnabled = true;
    }
    if (buf.includes(BRACKETED_PASTE_OFF) && managed.bracketedPasteEnabled) {
      managed.bracketedPasteEnabled = false;
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    void endAgentSession(id, 'normal');
    safeSend(IPC_CHANNELS.PTY_EXIT, { terminalId: id, exitCode });
    // Must precede flushPtyOutput: dispose reports the final screenful into the
    // reporter's buffer, and flushing first would ship the buffer without it.
    disposeTerminalScreen(id);
    flushPtyOutput(id);
    if (managed.mailPollTimer) {
      clearInterval(managed.mailPollTimer);
      managed.mailPollTimer = null;
    }
    cleanupBootPromptTmpFile(managed.bootPromptTmpPath);
    terminals.delete(id);
    // Report to acp-api via callback, WITH intent. Without the reason, acp-api
    // read every exit as a crash and crash-restarted panes we had deliberately
    // killed — see `intentionalExit` on ManagedPty.
    if (onPtyExit) {
      onPtyExit(agentName, id, exitCode, managed.intentionalExit);
    }
  });

  // Provider (which CLI to auto-inject) was resolved + recorded on `managed`
  // above through the single team-runtime authority (SPEC-team-runtime §3.1).
  // Per feedback_runtime_choice_vs_platform_llm — runtime here is the
  // user-team runtime (which CLI we launch for the agent), not the
  // platform LLM (advisor / data-tab) which is config-driven separately.
  setTimeout(() => {
    // Kimi cold-init of the SHARED ~/.kimi/kimi.json races when agents launch
    // near-together (the lead spawns first, with no warmup) → WinError 5 →
    // kimi crashes back to a raw shell. Bounded re-issue of `kimi --yolo`;
    // report-as is gated on the banner so we NEVER inject into a raw shell.
    let kimiAttempts = 0;
    let kimiRetrying = false;
    const KIMI_MAX_ATTEMPTS = 3;
    const kimiLaunch = () => {
      kimiAttempts++;
      ptyProcess.write(`kimi --yolo --model ${kimiPtyModel}\r`);
      console.log(`[PTY] Starting Kimi (yolo mode) for ${agentName} — attempt ${kimiAttempts}/${KIMI_MAX_ATTEMPTS}`);
    };
    if (provider === 'claude') {
      // Effort precedence (Aurum 1405, single authority — no second 'high'):
      //   per-agent override (opts.effort) -> global default (settings.claudeEffort) -> 'high'.
      // opts.effort comes from leg (a): the orchestrator plumbs
      // team_agent_instances.effort_override (engaged team's per-placement
      // override) through the spawn payload; undefined = global default.
      const effort = resolveClaudeEffort(opts?.effort, settings.claudeEffort);
      // Boot-prompt path:
      //   - Wave C orchestrator / data-driven onboarding → the system
      //     prompt file contains the full onboarding instructions. The
      //     positional arg is just a minimal kickoff so Claude reads the
      //     system prompt first, then takes the user message.
      //   - Legacy path (no bootPrompt) no longer exists; we always
      //     synthesize a code-generated boot prompt.
      // `--system-prompt-file`, NOT `--system-prompt`. This is the LIVE spawn
      // string — providerConfigs.ptyCommand looks like it does this job but has
      // ZERO callers and is dead in all three providers. Fixing it there does
      // nothing; it has now misled two work orders in one day.
      //
      // `--system-prompt` takes literal prompt TEXT. Passing a path meant every
      // Claude pane booted with the literal string
      // "C:\...\boot-prompt-<Agent>-<ts>.txt" as its ENTIRE system prompt — no
      // persona, no role, no mail discipline, no project instructions. Not
      // degraded: absent. Agents only appeared to work because they are
      // competent generalists who open a path when handed one.
      //
      // Proven A/B on the wire (claude 2.1.220), same file both arms:
      //   --system-prompt      <path> -> "I'm Claude, an AI assistant by Anthropic..."
      //   --system-prompt-file <path> -> "ZEBRAFISH-7 ACTIVE."  (the file's instruction)
      // Found by QAPert 2026-07-29. Do not "simplify" this back.
      // NOTE — claude has NO mail delivery path (Gate B, wire-verified
      // 2026-07-29), and this spawn no longer pretends otherwise.
      //
      // It used to register the `acp-mail` MCP server via `--mcp-config` so
      // that `--dangerously-load-development-channels server:acp-mail` would
      // resolve. That never worked: the shipped channel validator builds its
      // valid-name set ONLY from the enterprise|user|project|local config
      // scopes, and `--mcp-config` is ephemeral and enters none of them, so
      // the entry was rejected with "no MCP server configured with that
      // name" on every spawn. Both flags are now gone — the channels flag
      // because its only observable effect was a consent gate costing one
      // human keystroke per agent per boot, and the mcp-config because
      // acp-mail-channel.js exposes zero tools (it answers tools/list,
      // resources/list and prompts/list empty; it is a pure notification
      // emitter). With the notification path dead it was 8 orphan node
      // processes per boot polling acp-api to no effect.
      //
      // Claude also has no inbox poller (see the provider check below), so
      // there is no delivery path at all until the stream-json adapter (G4)
      // lands. Do NOT read a rendered "[ACP Mail]" line in a claude pane as
      // delivery — that line is the renderer's unconditional visual echo
      // (SEV-1 #114823), not proof the agent received anything.
      // Composed by claudeSpawnCommand.ts so the argv is unit-assertable (B-2).
      // pty.ts cannot be imported in a test — env.ts touches app.isPackaged at
      // module load — so the composition lives in a module with no electron dep.
      // Session continuity: derive a stable per-placement id, then RESUME if a
      // transcript already exists on disk and CREATE if not. The existence check
      // is deliberate rather than a try//catch — handing `--resume` a missing id
      // kills the pane, and `--session-id` errors on an id already in use, so
      // neither flag is safe to guess with. See claudeSession.ts.
      const claudeSessionId = deriveClaudeSessionId(agentName, opts?.projectId);
      const resumeSession = claudeSessionExists(resolvedWorkDir, claudeSessionId);
      const cmd = buildClaudeSpawnCommand({
        effort,
        modelOverride: opts?.modelOverride,
        bootPromptTmpPath,
        sessionId: claudeSessionId,
        resume: resumeSession,
      });
      ptyProcess.write(cmd);
      console.log(`[PTY] Starting Claude Code (effort: ${effort}${opts?.modelOverride ? `, model: ${opts.modelOverride}` : ''}, session: ${resumeSession ? 'RESUME' : 'new'} ${claudeSessionId}, acp-mail push: NONE — no delivery path on claude until the stream-json adapter lands, kickoff: "Begin."${bootPromptTmpPath ? ', system-prompt: ' + path.basename(bootPromptTmpPath) : ''}) for ${agentName}`);
    } else if (provider === 'codex') {
      const model = settings.codexModel || 'codex-mini';
      ptyProcess.write(`codex --full-auto --model ${model}\r`);
      console.log(`[PTY] Starting Codex (model: ${model}) for ${agentName}`);
    } else {
      // Kimi 2025-Q3: no --system-prompt flag exposed via CLI. Wave C
      // boot-prompt for Kimi PTY-injects after the banner (see data
      // listener below). Migrate to --system-prompt when upstream
      // exposes it — feedback_no_acknowledged_defect_ships flag.
      kimiLaunch();
    }

    // Kimi and Codex poll the inbox and inject new-mail lines directly into
    // their PTY stdin.
    //
    // Claude WAS excluded — historically because it was believed to get push
    // via acp-mail-channel.js (MCP channels). It never did: the channel name
    // never resolved (Gate B), so claude had BOTH no push and no poll, i.e.
    // no mail delivery whatsoever.
    //
    // INCLUDED 2026-07-29. The prior note said enabling this was "a capability
    // change and not this interim's scope", and preferred waiting for G4's
    // injectMail because that is the only variant where delivery is
    // ACKNOWLEDGED rather than assumed. That reasoning is right and still
    // stands as the destination — but it was weighing assumed-delivery against
    // acknowledged-delivery, when the live situation is assumed-delivery
    // against NONE. Measured cost of "none": Jon hand-relayed every message
    // between five agents for a full session and was told "you have new mail"
    // three times for mail that had provably never been delivered (QAPert,
    // msg 1548). A working path we cannot confirm beats a confirmable path
    // that does not exist yet.
    //
    // ⚠️ WHAT THIS DOES **NOT** BUY: this injects mail lines into the pane's
    // stdin, so delivery is ASSUMED. A rendered mail line here proves we wrote
    // bytes at a TUI — never that the agent received or acted on them. Do NOT
    // grade mail delivery by looking at a pane. A-7's bar stands unchanged:
    // the injected mail carries a nonce and the AGENT'S OWN OUTPUT must
    // demonstrate it acted on the nonce.
    //
    // Remove this once G4 lands injectMail on the runtime manager.
    startInboxPoller(managed);

    let reportSent = false;
    let buffer = '';
    const dataListener = ptyProcess.onData((data) => {
      buffer += data;

      if (provider === 'claude') {
        // Claude receives the initial prompt via positional CLI argv
        // — no PTY-side injection needed. Dispose the listener after
        // the first byte of output so we don't sit here forever.
        if (!reportSent) {
          reportSent = true;
          console.log(`[PTY] Claude booted for ${agentName} with initial prompt in argv`);
          dataListener.dispose();
        }
      } else if (provider === 'codex') {
        // Codex uses ">" as prompt after startup
        if (!reportSent && (buffer.includes('Codex') || buffer.includes('>')) && buffer.length > 200) {
          reportSent = true;
          console.log(`[PTY] Codex ready for ${agentName}, injecting boot prompt`);
          setTimeout(() => {
            injectBootPrompt(managed, bootPrompt);
          }, 1000);
          dataListener.dispose();
        }
      } else {
        // Kimi: a completed welcome box means it's actually up → inject the
        // code-generated onboarding prompt. We no longer send the bare
        // "report as" string; the boot prompt carries the full identity
        // and mail instructions, eliminating per-agent markdown files.
        // Readiness markers: kimi ≥0.27 dropped the static 'Tip:' line —
        // startup output is now the welcome box plus a server-driven tips
        // banner (see kimi-code tui/banner/banner-provider.ts) whose text
        // changes without notice. Match only the stable welcome box.
        if (!reportSent && buffer.includes('Welcome to Kimi Code!') && buffer.includes('Session:')) {
          reportSent = true;
          console.log(`[PTY] Kimi banner complete for ${agentName}, injecting boot prompt`);
          setTimeout(() => {
            injectBootPrompt(managed, bootPrompt);
          }, 1000);
          dataListener.dispose();
        } else if (
          !reportSent && !kimiRetrying &&
          kimiAttempts < KIMI_MAX_ATTEMPTS &&
          /Access is denied|WinError 5|\.kimi.*\.json|is not recognized/i.test(buffer)
        ) {
          // Cold-init race crashed kimi to a raw shell. Re-issue the launch
          // (kimi.json now exists → the retry wins, exactly like the manual
          // relaunch) instead of letting the fallback blind-inject report-as.
          kimiRetrying = true;
          console.warn(`[PTY] Kimi cold-init failed for ${agentName}; retrying launch`);
          setTimeout(() => { buffer = ''; kimiRetrying = false; kimiLaunch(); }, 800);
        }
      }
    });

    // Staggered fallback only needed for codex/kimi — claude gets
    // its initial prompt from argv, no PTY fallback required.
    if (provider !== 'claude') {
      const fallbackDelay = 5000 + (agentName.length * 500);
      setTimeout(() => {
        if (reportSent) return;
        if (provider === 'kimi') {
          // NEVER blind-inject `report as` for kimi — if it crashed, that
          // lands in a raw PowerShell prompt (the BAPert-lead "report not
          // recognized" bug). No banner in-window → retry the launch if
          // attempts remain (the data listener catches the retry's banner).
          // If exhausted, surface the failure (kanban #12), don't bury it.
          // Guard first: if the welcome box IS in the buffer, kimi is already
          // up (the data listener should have caught it — but a marker drift
          // must never re-type `kimi --yolo` into a live TUI input). Inject
          // the boot prompt instead of relaunching.
          if (buffer.includes('Welcome to Kimi Code!')) {
            reportSent = true;
            console.warn(`[PTY] Kimi welcome box seen but readiness check missed for ${agentName}; injecting boot prompt via fallback`);
            injectBootPrompt(managed, bootPrompt);
            dataListener.dispose();
            return;
          }
          if (kimiAttempts < KIMI_MAX_ATTEMPTS && !kimiRetrying) {
            kimiRetrying = true;
            console.warn(`[PTY] Kimi no-banner for ${agentName} after ${fallbackDelay}ms; retrying launch`);
            setTimeout(() => { buffer = ''; kimiRetrying = false; kimiLaunch(); }, 500);
            return;
          }
          console.error(`[PTY] Kimi FAILED to start for ${agentName} after ${KIMI_MAX_ATTEMPTS} attempts — surfacing, not injecting report-as into a dead shell`);
          safeSend(IPC_CHANNELS.PTY_DATA, { terminalId: id, data: `\r\n\x1b[31m[ACP] ${agentName} failed to start (kimi cold-init race). Restart the pane, or run: kimi --yolo\x1b[0m\r\n` });
          dataListener.dispose();
          return;
        }
        // codex — inject boot prompt as a last resort
        reportSent = true;
        console.log(`[PTY] Fallback: injecting boot prompt for ${agentName}`);
        injectBootPrompt(managed, bootPrompt);
        dataListener.dispose();
      }, fallbackDelay);
    }
  }, 500);

  return id;
}

/** Kill a terminal by terminal ID. Handles both PTY and ACP runtimes. */
export function killTerminal(terminalId: string): boolean {
  void endAgentSession(terminalId, 'killed');
  const terminal = terminals.get(terminalId);
  if (terminal) {
    // Record INTENT before the process dies. The onExit handler cannot tell a
    // crash from a deliberate kill on its own, and acp-api was therefore
    // treating every exit as a crash — so a restart (kill, then spawn) had its
    // kill reported as a crash, crash-restart fired, the freshly-spawned pane
    // was already up, and the attempt came back 409. Observed as a QAPert
    // restart loop on 2026-07-29. Intent must survive the exit.
    terminal.intentionalExit = 'killed';
    dropPtyOutput(terminalId);
    if (terminal.mailPollTimer) {
      clearInterval(terminal.mailPollTimer);
      terminal.mailPollTimer = null;
    }
    // #235: tree-kill so the powershell's detached claude.exe→node.exe→claude
    // grandchildren die too — bare pty.kill() reaped only the shell, orphaning
    // the descendants on a single-pane kill (same gap 7e9a36b fixed for
    // killAllPty).
    treeKillPty(terminal.pty);
    disposeTerminalScreen(terminalId);
    terminals.delete(terminalId);
    return true;
  }
  const runtime = acpRuntimes.get(terminalId);
  if (runtime) {
    runtime.kill();
    acpRuntimes.delete(terminalId);
    return true;
  }
  return false;
}

/** Resize a PTY */
export function resizeTerminal(terminalId: string, cols: number, rows: number): boolean {
  const terminal = terminals.get(terminalId);
  if (terminal) {
    terminal.pty.resize(cols, rows);
    // Keep the screen model's height in sync so shrink scrolls overflow rows
    // into history (renderer-visible) instead of silently clipping them.
    terminalScreens.get(terminalId)?.resize(cols, rows);
    scheduleTerminalFrameFlush(terminalId);
    return true;
  }
  return false;
}

/** Get terminal info by agent name.
 *  When projectId is provided, scopes to that project (P0 namespace fix).
 *  When omitted, falls back to global-by-name for legacy callers. */
export function getTerminalByAgent(agentName: string, projectId?: number): ManagedPty | undefined {
  for (const t of terminals.values()) {
    if (t.agentName === agentName) {
      if (projectId == null || t.projectId === projectId) return t;
    }
  }
  return undefined;
}

/** Get all active terminals. Includes the runtime/provider each PTY/ACP session
 *  was actually launched with (SPEC-team-runtime §3.2) so the renderer's
 *  reconcile-on-switch can detect agents running on a provider that no
 *  longer matches the team runtime. */
export function getActiveTerminals(): Array<{ id: string; agentName: string; projectId?: number; provider: AgentRuntime }> {
  const ptyEntries = Array.from(terminals.values()).map(t => ({ id: t.id, agentName: t.agentName, projectId: t.projectId, provider: t.provider }));
  const acpEntries = Array.from(acpRuntimes.entries()).map(([id, runtime]) => ({
    id,
    agentName: runtime.getAgentName(),
    projectId: runtime.getProjectId(),
    provider: runtime.getProvider(),
  }));
  return [...ptyEntries, ...acpEntries];
}

export function setupPtyHandlers(mainWindow: BrowserWindow | null) {
  mainWindowRef = mainWindow;

  // NOTE: the renderer-facing PTY_SPAWN IPC handler was DELETED (SPEC-team-
  // runtime §3.3 FLAG 6). It was the phantom !backendAvailable spawn fallback
  // that resolved runtime from the machine global — the masking fallback this
  // spec kills. The renderer now hard-surfaces when the backend is down
  // instead of issuing a guessed spawn. All real spawns go through the
  // lifecycle callback (/internal/pty/spawn) and the orchestrator, both of
  // which carry the team runtime. settings.agentProvider has no reader here.

  // Pre-flight working-dir validation (SPEC-workdir-invalid §3.5). The single
  // open-time gate the project-open flow calls BEFORE any spawn fan-out, and
  // the same check the inline correction surface runs before persisting a
  // user-typed path (validate-before-save). Delegates to resolveWorkDir — the
  // ONE workspace-root authority — so a path that passes here is exactly a path
  // spawnAgent won't reject. No fallback, no infer: resolveWorkDir returns null
  // for a missing dir, so ok=false carries through (the WorkDirError hard-stop
  // stays intact; this only moves WHEN the user learns about it). resolved is
  // the trimmed path on success, null on failure.
  ipcMain.handle(IPC_CHANNELS.WORKDIR_VALIDATE, (_, workDir: string): { ok: boolean; resolved: string | null } => {
    const resolved = resolveWorkDir(workDir);
    return { ok: resolved !== null, resolved };
  });

  ipcMain.on(IPC_CHANNELS.PTY_WRITE, (_, terminalId: string, data: string) => {
    // ACP runtimes (Kimi/Codex via ACP/Kimi CLI) share the same terminalId
    // namespace as PTY terminals. Redirect writes aimed at an ACP runtime
    // through the runtime's prompt channel so mail push and other injections
    // land in the agent's chat context instead of being silently dropped.
    const acpRuntime = acpRuntimes.get(terminalId);
    if (acpRuntime) {
      const text = data.replace(/\r?\n$/, '');
      console.log(`[PTY] writeTerminal routed to ACP runtime for ${acpRuntime.getAgentName()}: ${text.substring(0, 120)}${text.length > 120 ? '...' : ''}`);
      acpRuntime.prompt(text).catch((err) => {
        console.warn(`[ACP] PTY-write routed as prompt failed for ${acpRuntime.getAgentName()}:`, err);
      });
      return;
    }

    const terminal = terminals.get(terminalId);
    if (terminal) {
      // Paced + chunked (paste-truncation fix) — see queuePtyWrite. Keystrokes
      // take the immediate fast path; large pastes drain without overrunning
      // the ConPTY console-input buffer.
      queuePtyWrite(terminal, data);
      return;
    }

    console.warn(`[PTY] writeTerminal: no terminal or ACP runtime found for terminalId=${terminalId}`);
  });

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_, terminalId: string, cols: number, rows: number) => {
    resizeTerminal(terminalId, cols, rows);
  });

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_, terminalId: string) => {
    killTerminal(terminalId);
  });

  // Renderer reconcile-on-switch (SPEC-team-runtime §3.2) reads the live
  // terminals + the provider each was launched with, to find agents whose
  // running provider no longer matches the team runtime.
  ipcMain.handle(IPC_CHANNELS.PTY_LIST, () => getActiveTerminals());

  // ACP (Agent Client Protocol) transport handlers. These route renderer
  // composer/actions to the structured JSON-RPC runtime for Kimi and future
  // ACP-capable providers. Claude/Codex continue to use the PTY handlers above.
  ipcMain.handle(IPC_CHANNELS.ACP_PROMPT, async (_, payload: AcpPromptPayload) => {
    const runtime = getAcpRuntimeByAgent(payload.agent);
    if (!runtime) {
      console.warn(`[ACP] prompt for unknown agent: ${payload.agent}`);
      return;
    }
    console.log(`[ACP main] prompt received for ${payload.agent}: ${payload.text.slice(0, 80)} (images=${payload.images?.length ?? 0})`);
    await runtime.prompt(payload.text, payload.images);
  });

  ipcMain.handle(IPC_CHANNELS.ACP_INJECT_MAIL, async (_, payload: AcpInjectMailPayload) => {
    const runtime = getAcpRuntimeByAgent(payload.agent);
    if (!runtime) {
      console.warn(`[ACP] inject-mail for unknown agent: ${payload.agent}`);
      return false;
    }
    console.log(`[ACP main] mail notice received for ${payload.agent}: ${payload.text.slice(0, 80)}`);
    return runtime.injectMail(payload.text);
  });

  ipcMain.handle(IPC_CHANNELS.ACP_CANCEL, (_, payload: AcpCancelPayload) => {
    const runtime = getAcpRuntimeByAgent(payload.agent);
    if (!runtime) {
      console.warn(`[ACP main] cancel for unknown agent: ${payload.agent}`);
      return;
    }
    console.log(`[ACP main] cancel received for ${payload.agent}`);
    runtime.cancel();
  });

  ipcMain.handle(IPC_CHANNELS.ACP_PURGE_QUEUE, (_, payload: AcpPurgeQueuePayload) => {
    const runtime = getAcpRuntimeByAgent(payload.agent);
    if (!runtime) {
      console.warn(`[ACP main] purge-queue for unknown agent: ${payload.agent}`);
      return 0;
    }
    const dropped = runtime.purgeQueue();
    if (dropped > 0) {
      console.log(`[ACP main] purged ${dropped} queued prompt(s) for ${payload.agent} on user interrupt`);
    }
    return dropped;
  });

  ipcMain.handle(IPC_CHANNELS.ACP_SET_MODE, (_, payload: AcpSetModePayload) => {
    getAcpRuntimeByAgent(payload.agent)?.setMode(payload.mode);
  });

  ipcMain.handle(IPC_CHANNELS.ACP_KILL, (_, payload: AcpKillPayload) => {
    const runtime = getAcpRuntimeByAgent(payload.agent);
    if (!runtime) return;
    killTerminal(runtime.getId());
  });

  ipcMain.handle(IPC_CHANNELS.ACP_PERMISSION_RESPONSE, (_, payload: AcpPermissionResponsePayload) => {
    getAcpRuntimeByAgent(payload.agent)?.respondToPermission(
      payload.permissionRequestId,
      payload.optionId ?? 'reject',
      payload.outcome,
    );
  });
}

/**
 * Tree-kill a PTY so its GRANDCHILDREN (the claude/node processes the shell
 * spawned) die too. node-pty's pty.kill() signals only the shell on Windows,
 * leaving claude/node orphaned — they keep running after the app quits. The
 * shell is NOT in a job object, so `taskkill /T` is what reaps the whole tree.
 * Falls back to pty.kill() off-Windows or if taskkill fails.
 */
function treeKillPty(p: pty.IPty): void {
  try {
    if (process.platform === 'win32' && p.pid) {
      execSync(`taskkill /PID ${p.pid} /T /F`, { timeout: 5000, stdio: 'ignore' });
      return;
    }
  } catch {
    // taskkill exits non-zero if the tree is already gone — fall through to
    // a best-effort kill below.
  }
  try { p.kill(); } catch { /* already dead */ }
}

export function killAllPty() {
  terminals.forEach((terminal) => {
    void endAgentSession(terminal.id, 'normal');
    if (terminal.mailPollTimer) {
      clearInterval(terminal.mailPollTimer);
      terminal.mailPollTimer = null;
    }
    treeKillPty(terminal.pty);
  });
  terminals.clear();
  acpRuntimes.forEach((runtime) => {
    void endAgentSession(runtime.getId(), 'normal');
    runtime.kill();
  });
  acpRuntimes.clear();
}
