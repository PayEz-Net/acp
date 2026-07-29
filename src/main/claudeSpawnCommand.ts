/**
 * Claude pane spawn-command composition (WO per-agent model + effort).
 *
 * Deliberately a standalone module with NO electron imports: `pty.ts` reaches
 * `app.isPackaged` transitively through `env.ts` at module load, so anything
 * importing pty.ts cannot be unit-tested. The composed argv is the thing B-2
 * has to assert, so it has to be reachable from a test.
 */

import { type ClaudeEffort } from '../shared/types';

/**
 * Resolve the effort a Claude pane spawns with.
 *
 * Precedence, unchanged from the spawn site: per-placement override →
 * global `settings.claudeEffort` → 'high'.
 */
export function resolveClaudeEffort(
  override: ClaudeEffort | undefined | null,
  settingsEffort: ClaudeEffort | undefined | null,
): ClaudeEffort {
  return override || settingsEffort || 'high';
}

/**
 * Compose the exact command string written into the Claude pane's shell.
 *
 * THIS is the live spawn path. `providerConfigs.ptyCommand` is dead code —
 * nothing in src/ calls it — so an argv assertion written against that
 * function passes while the child receives nothing.
 *
 * `bootPromptTmpPath` goes to `--system-prompt-file`, NOT `--system-prompt`:
 * the latter takes literal prompt TEXT, so passing a path made the path string
 * itself the entire system prompt (QAPert, 2026-07-29).
 */
export function buildClaudeSpawnCommand(opts: {
  effort: ClaudeEffort;
  modelOverride?: string | null;
  bootPromptTmpPath?: string | null;
  kickoff?: string;
}): string {
  const kickoff = opts.kickoff ?? 'Begin.';
  const parts = [
    `claude "${kickoff}"`,
    '--dangerously-skip-permissions',
    `--effort ${opts.effort}`,
  ];
  // `--model` accepts an alias ('opus', 'sonnet', 'fable') or a full model
  // name, so the value is passed through verbatim rather than mapped through a
  // table that would need editing every time a new alias ships. Validity is
  // enforced client-side before save (a model is only valid for the resolved
  // runtime of that placement); an unset override must omit the flag entirely,
  // because a bare `--model` fails the spawn.
  if (opts.modelOverride) parts.push(`--model ${opts.modelOverride}`);
  if (opts.bootPromptTmpPath) parts.push(`--system-prompt-file "${opts.bootPromptTmpPath}"`);
  return `${parts.join(' ')}\r`;
}
