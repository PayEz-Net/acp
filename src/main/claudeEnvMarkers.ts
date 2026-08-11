/**
 * Parent environment with the launching Claude session's markers removed.
 *
 * If the ACP is started from inside a Claude Code session, every pane inherits
 * that session's markers — including `CLAUDE_CODE_CHILD_SESSION`, which makes the
 * child treat itself as a sub-session and **disables transcript saving**.
 *
 * That is not cosmetic. No transcript means nothing for `--resume` to resume, so
 * session continuity silently degrades to a fresh conversation on every restart —
 * the pane reports `session: new` forever and the failure looks like a resume bug
 * rather than an inherited env var. Diagnosed the hard way on 2026-07-29: the
 * "Transcript saving is off" warning was dismissed as a launch artifact, then
 * turned out to be why resume never engaged.
 *
 * A pane is an INDEPENDENT agent session, not a child of whatever launched the
 * app, so the app must not inherit that identity regardless of how it was
 * started. `CLAUDE_CODE_GIT_BASH_PATH` is deliberately KEPT — it is machine
 * config, not session identity.
 *
 * Extracted from pty.ts 2026-08-11 (117423) so the stream-json bridge spawns
 * under the identical strip without importing the PTY module. Wire-verified on
 * claude 2.1.227: the transcript suppression does not reproduce in `-p`
 * stream-json mode, but the marker has other sub-session semantics and the
 * suppression could return in any CLI upgrade — the strip stays mandatory.
 */
export function parentEnvWithoutClaudeMarkers(): NodeJS.ProcessEnv {
  const {
    CLAUDE_CODE_CHILD_SESSION: _childSession,
    CLAUDE_CODE_SESSION_ID: _sessionId,
    CLAUDECODE: _claudeCode,
    CLAUDE_PID: _claudePid,
    CLAUDE_AGENTS_SELECT: _agentsSelect,
    CLAUDE_EFFORT: _parentEffort,
    ...rest
  } = process.env;
  return rest;
}
