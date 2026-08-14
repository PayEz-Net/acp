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
/**
 * Model ids that belong to a runtime OTHER than claude.
 *
 * Kept as an explicit deny-list of names we can point at, so a claude alias we
 * have never heard of still passes through. `kimi-code/` prefixes are matched too
 * because that is the spawn-time alias form.
 */
const FOREIGN_RUNTIME_MODELS: ReadonlySet<string> = new Set([
  'k3',
  'k3-256k',
  'kimi-for-coding',
  'kimi-for-coding-highspeed',
]);

export function isForeignRuntimeModel(modelId: string): boolean {
  const bare = modelId.replace(/^kimi-code\//, '').trim();
  return FOREIGN_RUNTIME_MODELS.has(bare) || bare.startsWith('kimi');
}

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
  /** Stable per-placement session id. See claudeSession.ts. */
  sessionId?: string | null;
  /**
   * True when a transcript for `sessionId` already exists on disk, so the
   * conversation should be RESUMED rather than created. The caller decides this
   * by checking the file — `--session-id` errors on an existing id, so it cannot
   * be used as resume-or-create.
   */
  resume?: boolean;
}): string {
  const kickoff = opts.kickoff ?? 'Begin.';
  const parts = [
    `claude "${kickoff}"`,
    '--dangerously-skip-permissions',
    `--effort ${opts.effort}`,
  ];
  // Session continuity. `--resume` picks up the existing conversation;
  // `--session-id` creates one under an id we can resume next time. Mutually
  // exclusive: passing an in-use id to `--session-id` errors out and kills the
  // spawn ("Session ID <uuid> is already in use").
  if (opts.sessionId) {
    parts.push(opts.resume ? `--resume ${opts.sessionId}` : `--session-id ${opts.sessionId}`);
  }
  // `--model` accepts an alias ('opus', 'sonnet', 'fable') or a full model
  // name, so the value is passed through verbatim rather than mapped through a
  // table that would need editing every time a new alias ships. Validity is
  // enforced client-side before save (a model is only valid for the resolved
  // runtime of that placement); an unset override must omit the flag entirely,
  // because a bare `--model` fails the spawn.
  // Drop a model that belongs to ANOTHER runtime rather than handing it to
  // claude. `model_override` is interpreted against the RESOLVED runtime, and
  // prod carries kimi-era values (`kimi-for-coding`, `k3`) on placements that now
  // resolve to claude. Passing those through produced "may not exist or you may
  // not have access to it" on all eight prod panes — the model override existed
  // for months but was inert until this file started honouring it, so wiring it
  // correctly turned a dormant data problem into a live break.
  //
  // REJECT-KNOWN-WRONG, not allow-known-right: an allowlist of claude aliases
  // would silently drop each new alias Anthropic ships (`haiku` is already absent
  // from `claude --help`'s examples yet works). This only refuses ids we can name
  // as belonging elsewhere, and says so.
  const foreign = opts.modelOverride && isForeignRuntimeModel(opts.modelOverride);
  if (foreign) {
    console.warn(
      `[ClaudeSpawn] IGNORING model_override '${opts.modelOverride}' — that is a ` +
        `kimi model id and this placement resolved to claude. Spawning with the ` +
        `default model. Fix the placement's model_override (or its ` +
        `runtime_override) so the tuple agrees.`,
    );
  }
  if (opts.modelOverride && !foreign) parts.push(`--model ${opts.modelOverride}`);
  if (opts.bootPromptTmpPath) parts.push(`--system-prompt-file "${opts.bootPromptTmpPath}"`);
  return `${parts.join(' ')}\r`;
}
