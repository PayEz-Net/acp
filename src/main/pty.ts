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
  type SpawnFailedPayload,
  type TerminalProvider,
} from '../shared/types';
import {
  type AcpEventPayload,
  type AcpPromptPayload,
  type AcpInjectMailPayload,
  type AcpSendMessagePayload,
  type AcpCancelPayload,
  type AcpSetModePayload,
  type AcpKillPayload,
  type AcpPermissionResponsePayload,
} from '../shared/acpTypes';
import { getSettings } from './store';
import { reportPtyOutput, flushPtyOutput, dropPtyOutput } from './ptyOutputReporter';
import { AcpRuntimeManager } from './acp/AcpRuntimeManager';
import { getProviderConfig } from './acp/providerConfigs';
import { buildAgentBootPrompt } from './acp/bootPrompt';
import { startAgentSession, endAgentSession } from './agentSessionLifecycle';


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
  // Path to the boot-prompt tmp file passed via --system-prompt (Claude)
  // or kept for reference when PTY-injected (Kimi/Codex). Cleaned up on
  // PTY exit. Null when no boot-prompt was provided (legacy 4-pane mode
  // or the orchestrator passed bootPrompt:null).
  bootPromptTmpPath: string | null;
  // Path to the per-spawn MCP config tmp file passed via --mcp-config so
  // Claude's `--dangerously-load-development-channels server:acp-mail`
  // resolves the acp-mail push channel. Per-spawn (not a shared cwd
  // .mcp.json) so each agent's ACP_AGENT_NAME is collision-free. Cleaned
  // on PTY exit. Null for non-claude / when the channel script is absent.
  mcpConfigTmpPath: string | null;
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
}

export type AgentRuntime = TerminalProvider;

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'max';

export interface SpawnAgentOptions {
  /** Wave D assembled system prompt from `/v1/projects/:id/boot-prompt/:agent_id`.
   *  When provided, replaces the legacy "report as <Agent>" kickoff: Claude
   *  receives it via `--system-prompt <file>`; Kimi/Codex receive it via
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
  /** Per-agent effort override (Claude-only), consumed at spawn as
   *  `--effort`. Leg (b) of effort_override consumption (Aurum 1405):
   *  the spawn resolver defers to ONE chain —
   *    per-agent override -> single global default (settings.claudeEffort) -> 'high'.
   *  undefined = inherit (NOT a DB-baked literal; migration 14's
   *  effort_override column has no DEFAULT, so NULL round-trips as
   *  "defer to the resolver"). The renderer/orchestrator reads
   *  project_team_members.effort_override (same path as `runtime`) and
   *  threads it here — leg (a), NextPert. Kimi/Codex have no effort
   *  lever, so this is ignored for those runtimes. */
  effort?: ClaudeEffort;
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

// Exit callback — set by lifecycle-server to report PTY exits to acp-api
let onPtyExit: ((agentName: string, terminalId: string, exitCode: number) => void) | null = null;

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
  const { agentName, projectId, pty: ptyProcess } = managed;
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
      const line =
        `[ACP Mail] New message from ${from}: "${subject}" (id ${id}). ` +
        `Read with: curl -s ${apiBase}/v1/mail/messages/${id} -H "X-ACP-Agent: ${agentName}"\r`;
      ptyProcess.write(line);
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

/**
 * Per-spawn MCP config so Claude's `--dangerously-load-development-
 * channels server:acp-mail` finds an MCP server named `acp-mail`
 * (claude-code-guide: that flag requires a registered server of that
 * name; --mcp-config satisfies it and must precede the flag). Per-spawn
 * (not a shared-cwd .mcp.json) → each agent's ACP_AGENT_NAME is
 * collision-free across the 5 concurrent agents sharing the workspace.
 * channelJs = resources/bin/acp-mail-channel.js (X-ACP-Agent auth, reads
 * ACP_AGENT_NAME/ACP_API_URL — no secret). Returns the tmp path, or null
 * if the channel script is missing (skip the flag; no push but spawn
 * unaffected — same as today, never worse).
 */
function writeMcpConfigTmpFile(agentName: string, channelJs: string, apiUrl: string): string | null {
  if (!fs.existsSync(channelJs)) {
    console.warn(`[PTY] acp-mail channel script missing (${channelJs}); ${agentName} spawns WITHOUT push (mail still pollable)`);
    return null;
  }
  const cfg = {
    mcpServers: {
      'acp-mail': {
        type: 'stdio',
        command: 'node',
        args: [channelJs],
        env: { ACP_AGENT_NAME: agentName, VIBE_AGENT: agentName, ACP_API_URL: apiUrl },
      },
    },
  };
  const dir = path.join(app.getPath('userData'), 'tmp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, `mcp-acp-mail-${agentName}-${Date.now()}.json`);
  fs.writeFileSync(filepath, JSON.stringify(cfg, null, 2), { encoding: 'utf8' });
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
 * `--system-prompt <file>` (full Wave D assembled prompt). Kimi/Codex
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
  // reference it via --system-prompt (Claude) and the orchestrator
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
    mcpConfigTmpPath: null,
    writeBuf: '',
    writeDraining: false,
  };
  terminals.set(id, managed);

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
    reportPtyOutput(
      agentName,
      id,
      data,
      provider,
      opts?.projectId ? String(opts.projectId) : undefined,
      undefined,
      managed.sessionToken,
    );

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
    flushPtyOutput(id);
    if (managed.mailPollTimer) {
      clearInterval(managed.mailPollTimer);
      managed.mailPollTimer = null;
    }
    cleanupBootPromptTmpFile(managed.bootPromptTmpPath);
    cleanupBootPromptTmpFile(managed.mcpConfigTmpPath);
    terminals.delete(id);
    // Report to acp-api via callback
    if (onPtyExit) {
      onPtyExit(agentName, id, exitCode);
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
      ptyProcess.write(`kimi --yolo --model kimi-for-coding-highspeed\r`);
      console.log(`[PTY] Starting Kimi (yolo mode) for ${agentName} — attempt ${kimiAttempts}/${KIMI_MAX_ATTEMPTS}`);
    };
    if (provider === 'claude') {
      // Effort precedence (Aurum 1405, single authority — no second 'high'):
      //   per-agent override (opts.effort) -> global default (settings.claudeEffort) -> 'high'.
      // opts.effort is undefined until leg (a) plumbs project_team_members.effort_override
      // through the spawn payload; until then this is identical to the global default.
      const effort = opts?.effort || settings.claudeEffort || 'high';
      // Boot-prompt path:
      //   - Wave C orchestrator / data-driven onboarding → the system
      //     prompt file contains the full onboarding instructions. The
      //     positional arg is just a minimal kickoff so Claude reads the
      //     system prompt first, then takes the user message.
      //   - Legacy path (no bootPrompt) no longer exists; we always
      //     synthesize a code-generated boot prompt.
      const systemPromptFlag = bootPromptTmpPath
        ? ` --system-prompt "${bootPromptTmpPath}"`
        : '';
      // Register the `acp-mail` MCP server for THIS spawn so
      // `--dangerously-load-development-channels server:acp-mail`
      // actually resolves (root cause of "claude has no push" — the
      // channel server was never configured: "no MCP server configured
      // with that name"). Tmp-file (not inline JSON) — PowerShell PTY
      // can't safely carry quoted JSON, same reason boot-prompt is a
      // file. MUST precede the channels flag (claude-code-guide).
      const mcpCfg = writeMcpConfigTmpFile(
        agentName,
        path.join(acpBinDir, 'acp-mail-channel.js'),
        process.env.ACP_API_URL || 'http://localhost:3001',
      );
      managed.mcpConfigTmpPath = mcpCfg;
      const mcpConfigFlag = mcpCfg ? ` --mcp-config "${mcpCfg}"` : '';
      const cmd = `claude "Begin."${mcpConfigFlag} --dangerously-skip-permissions --effort ${effort} --dangerously-load-development-channels server:acp-mail${systemPromptFlag}\r`;
      ptyProcess.write(cmd);
      console.log(`[PTY] Starting Claude Code (effort: ${effort}, acp-mail push: ${mcpCfg ? 'registered via --mcp-config' : 'MISSING — channel script absent'}, kickoff: "Begin."${bootPromptTmpPath ? ', system-prompt: ' + path.basename(bootPromptTmpPath) : ''}) for ${agentName}`);
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

    // Claude gets push via acp-mail-channel.js (MCP channels). Kimi and
    // Codex don't support MCP channels, so poll the inbox and inject
    // new-mail lines directly into their PTY stdin.
    if (provider !== 'claude') {
      startInboxPoller(managed);
    }

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
        // Kimi: a completed banner means it's actually up → inject the
        // code-generated onboarding prompt. We no longer send the bare
        // "report as" string; the boot prompt carries the full identity
        // and mail instructions, eliminating per-agent markdown files.
        if (!reportSent && buffer.includes('Session:') && buffer.includes('Tip:')) {
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
    console.log(`[ACP main] prompt received for ${payload.agent}: ${payload.text.slice(0, 80)}`);
    await runtime.prompt(payload.text);
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

  ipcMain.handle(IPC_CHANNELS.ACP_SEND_MESSAGE, async (_, payload: AcpSendMessagePayload) => {
    const runtime = getAcpRuntimeByAgent(payload.agent);
    if (!runtime) {
      console.warn(`[ACP] send-message for unknown agent: ${payload.agent}`);
      return;
    }
    await runtime.sendMessage(payload.content);
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
