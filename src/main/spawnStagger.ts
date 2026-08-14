/**
 * Spawn stagger policy (kanban 177737).
 *
 * WHY THIS EXISTS. Restarting the rig spawned all 7 agents' sessions in the
 * same instant — a thundering herd that drew a provider 429 on every boot
 * (absorbed by the provider's own backoff that time; it grows with team
 * size). The spawn loop previously spaced only NON-claude spawns, and only
 * for an unrelated reason (the kimi/codex shared-config init race) — claude
 * spawns, the ones that hit the API immediately with their boot prompts, had
 * zero spacing.
 *
 * THE POLICY. After each successful spawn, wait before starting the next:
 *   - every provider: ACP_SPAWN_STAGGER_MS (default 4000) + up to 2000ms
 *     deterministic-jitter, so N spawns spread over ~(N-1)*4-6s instead of
 *     one instant;
 *   - non-claude providers: never below 3000ms — that floor is the pre-existing
 *     kimi/codex user-global config init race guard (~/.kimi/kimi.json
 *     temp→atomic-rename loses with WinError 5 under concurrent first-runs),
 *     kept, not widened.
 *
 * The env override exists so a boot-time test or a huge team can tune it
 * without a rebuild; 0 is a legitimate explicit "no stagger".
 */
export const DEFAULT_SPAWN_STAGGER_MS = 4000;
export const SPAWN_STAGGER_JITTER_MS = 2000;
export const MIN_NON_CLAUDE_SPAWN_STAGGER_MS = 3000;

export function computeSpawnStaggerMs(
  provider: string | undefined,
  rand: () => number = Math.random,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ACP_SPAWN_STAGGER_MS;
  let base = DEFAULT_SPAWN_STAGGER_MS;
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) base = parsed;
    // An unparsable/negative override is ignored — a bad knob must not
    // silently re-enable the herd, and it must not crash boot either.
  }
  if (provider !== 'claude') {
    base = Math.max(base, MIN_NON_CLAUDE_SPAWN_STAGGER_MS);
  }
  const jitter = Math.floor(rand() * (SPAWN_STAGGER_JITTER_MS + 1));
  return base + jitter;
}
