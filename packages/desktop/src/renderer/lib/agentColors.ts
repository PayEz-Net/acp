/**
 * Deterministic name → color mapping for agent archetypes.
 *
 * Spec ref: `acp-dynamic-team-loading-v1-spec.md` §4.2.1.
 *
 * Used by `agentReconcile`, `TeamSyncBanner`, and any UI surface that
 * needs a default color when local has none. Known archetypes get their
 * team-canonical colors; unknown archetypes get a deterministic palette
 * pick via FNV-1a 32-bit hash. `Math.imul` is used so the hash behaves
 * identically on every JS engine.
 */

const PALETTE = [
  '#8b5cf6', // violet — BAPert default
  '#f59e0b', // amber  — QAPert default
  '#06b6d4', // cyan   — DotNetPert default
  '#22c55e', // green  — NextPert default
  '#f97316', // orange — Aurum default
  '#ec4899', // pink
  '#14b8a6', // teal
  '#a855f7', // purple
];

const KNOWN: Record<string, string> = {
  BAPert: '#8b5cf6',
  QAPert: '#f59e0b',
  DotNetPert: '#06b6d4',
  NextPert: '#22c55e',
  Aurum: '#f97316',
};

export function colorForArchetype(name: string): string {
  if (KNOWN[name]) return KNOWN[name];
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}
