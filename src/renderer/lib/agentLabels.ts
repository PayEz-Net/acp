/**
 * Agent header labels — AC-4 dual-label rule.
 *
 * Spec ref: `acp-dynamic-team-loading-v1-spec.md` AC-4 + GSD §5.
 *
 * The user's display name is the primary label; the archetype name is
 * shown small below ONLY when it differs from the display name. Default
 * state (displayName === name) avoids redundant duplicate stacking.
 */
import type { AgentConfig } from '@shared/types';

/**
 * Returns the archetype label for the small-secondary slot, or `null`
 * when the user hasn't renamed the agent (display name == archetype).
 *
 * Example:
 *   { name: 'BAPert', displayName: 'Alex' }    → 'BAPert'
 *   { name: 'BAPert', displayName: 'BAPert' }  → null
 *   { name: 'BAPert', displayName: '' }        → null  (no rename → suppress)
 */
export function archetypeLabelFor(agent: Pick<AgentConfig, 'name' | 'displayName'>): string | null {
  if (!agent.displayName) return null;
  if (agent.displayName === agent.name) return null;
  return agent.name;
}
