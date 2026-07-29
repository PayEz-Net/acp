/**
 * Claude pane session identity + resumption.
 *
 * WHY. Claude panes never resumed: the spawn carried no session flags at all, so
 * every restart was a brand-new conversation and agents lost everything they had
 * been reasoning about. Jon: "getting right back to where you were" is the whole
 * value.
 *
 * WHAT THE WIRE SAYS (claude 2.1.220, verified 2026-07-29 — three of these four
 * are undocumented interactions, so re-verify on a version bump):
 *
 *   --session-id <new uuid>                    creates the session
 *   --session-id <EXISTING uuid>               ERRORS: "Session ID ... already in use"
 *   --resume <uuid>                            resumes the conversation
 *   --resume <uuid> --system-prompt-file X     resumes conversation AND re-applies
 *                                              the system prompt
 *
 * Two consequences drive this module:
 *
 * 1. `--session-id` is NOT resume-or-create — it errors on an existing id. So the
 *    spawn has to know, BEFORE composing the command, whether a session exists.
 * 2. `--system-prompt-file` must be re-passed on resume. Without it the agent
 *    keeps the conversation but loses its explicit operating rules (mail
 *    discipline, tool conventions). Its NAME and role survive — they are all over
 *    the transcript, so identity is reconstructed from context — but the rules are
 *    not, and re-passing costs nothing.
 *
 * HOW WE AVOID A FALLBACK LOOP. Claude stores each session as a file:
 *   ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
 * so existence is a filesystem check, not an error to be caught. That matters: a
 * stale id handed to `--resume` KILLS the pane, which is exactly the crash-loop
 * shape hit earlier today when `--system-prompt-file` was handed a deleted path.
 * Checking first means the bad case never happens, instead of being recovered
 * from. If the file is gone we simply create a new session — self-healing, no
 * retry, no persisted state to go stale.
 *
 * The id is DERIVED, not stored, so there is nothing to keep in sync: a stable
 * UUIDv5-shaped hash of (projectId, agentName). Same agent in a different project
 * gets a different conversation, matching how the other per-placement overrides
 * are scoped.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Namespace for the derived session ids — arbitrary but must never change. */
const ACP_SESSION_NAMESPACE = 'acp-desktop.claude.session.v1';

/**
 * Stable session UUID for one agent placement.
 *
 * Derived rather than persisted: no store to drift, no migration, and a wiped
 * session directory just means the next spawn creates a fresh conversation under
 * the same id. Shaped as a v5 UUID because `--session-id` requires a valid UUID.
 */
export function deriveClaudeSessionId(
  agentName: string,
  projectId: number | string | undefined,
): string {
  const key = `${ACP_SESSION_NAMESPACE}|${projectId ?? 'no-project'}|${agentName}`;
  const h = crypto.createHash('sha1').update(key).digest('hex');
  // Force the version (5) and variant (10xx) nibbles so it is a well-formed UUID.
  const v = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(
    (parseInt(h.slice(16, 17), 16) & 0x3) | 0x8
  ).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return v;
}

/**
 * Claude's on-disk slug for a working directory.
 *
 * Observed: `E:\Repos` → `E--Repos`, i.e. every character outside [A-Za-z0-9] and
 * `.`/`_` collapses to `-` (the drive colon and the separator become two dashes).
 * Derived from observation, not documentation — hence `claudeSessionExists`
 * returning false on any surprise rather than guessing.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9._]/g, '-');
}

/**
 * Home directory Claude stores its transcripts under.
 *
 * Reads the environment BEFORE falling back to `os.homedir()`. On Windows
 * `os.homedir()` queries the OS rather than `USERPROFILE`, so it ignores an
 * override — which made this module untestable without touching the real home
 * directory, and a test that reads your actual `~/.claude` finds real sessions
 * and passes for the wrong reason.
 */
function claudeHome(): string {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/** Path Claude would use for a session transcript in `cwd`. */
export function claudeSessionFile(cwd: string, sessionId: string): string {
  return path.join(
    claudeHome(),
    '.claude',
    'projects',
    claudeProjectSlug(cwd),
    `${sessionId}.jsonl`,
  );
}

/**
 * Does a resumable session already exist?
 *
 * FALSE on any doubt. A false negative costs one lost conversation; a false
 * positive hands `--resume` a missing id, which kills the pane on spawn. The
 * asymmetry is the whole reason this is a check and not a try/catch.
 */
export function claudeSessionExists(cwd: string, sessionId: string): boolean {
  try {
    const f = claudeSessionFile(cwd, sessionId);
    return fs.existsSync(f) && fs.statSync(f).size > 0;
  } catch {
    return false;
  }
}
