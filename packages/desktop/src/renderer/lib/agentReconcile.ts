/**
 * Agent reconcile — merges cloud-authoritative roster with local UI prefs.
 *
 * Spec ref: `acp-dynamic-team-loading-v1-spec.md` §4.2 + ACs §7
 * (AC-18, AC-19 incl. collision adversarial cases, AC-20).
 *
 * Two-pass position algorithm — collision-free by construction:
 *   Pass 1: claim positions held by local prefs (sort-order-stable).
 *   Pass 2: fill new agents into the first available slot in `startupOrder`
 *           ascending; overflow (>4 agents) returns `position: undefined`.
 *
 * Cloud wins on identity (id, name, displayName).
 * Local wins on layout (workDir, position, color, provider, autoStart),
 * keyed by archetype `name`.
 *
 * Orphan local entries (cloud no longer has them) drop silently — that
 * IS the migration per spec §5.1.
 */
import type { AgentConfig } from '@shared/types';
import { colorForArchetype } from './agentColors';

export interface NormalizedAgent {
  id: number;
  name: string;
  displayName: string;
  description?: string;
  isActive: boolean;
  agentType?: string;
  rolePreset?: string;
  isCoordinator?: boolean;
  startupOrder?: number;
  expertiseTags?: string[];
}

const POSITIONS: AgentConfig['position'][] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

// Renderer NEVER resolves a workspace path (single-authority, spec §2).
// Empty = "no explicit choice"; main's resolveWorkDir owns the decision.
const DEFAULT_WORKDIR = '';

export function agentReconcile(
  cloud: NormalizedAgent[],
  localPrefs: AgentConfig[],
): AgentConfig[] {
  const localByName = new Map(localPrefs.map((a) => [a.name, a]));

  const sorted = [...cloud].sort((a, b) => {
    const oa = a.startupOrder ?? Number.MAX_SAFE_INTEGER;
    const ob = b.startupOrder ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });

  const taken = new Set<AgentConfig['position']>();
  const assigned = new Map<string, AgentConfig['position'] | undefined>();

  // Pass 1 — claim local-pref positions, sort-order-stable. If two local
  // prefs collide on the same position (corrupt local state), the earlier
  // sort-order entry wins; the later one falls through to Pass 2.
  for (const c of sorted) {
    const local = localByName.get(c.name);
    if (local?.position && !taken.has(local.position)) {
      taken.add(local.position);
      assigned.set(c.name, local.position);
    }
  }

  // Pass 2 — fill remaining agents into first available slot. Overflow
  // (>4 cloud agents) gets `position: undefined`; the 4-pane grid simply
  // won't render those panes in v1.
  for (const c of sorted) {
    if (assigned.has(c.name)) continue;
    const slot = POSITIONS.find((p) => !taken.has(p));
    if (slot) {
      taken.add(slot);
      assigned.set(c.name, slot);
    } else {
      assigned.set(c.name, undefined);
    }
  }

  return sorted.map((c) => {
    const local = localByName.get(c.name);
    return {
      id: String(c.id),
      name: c.name,
      displayName: c.displayName,
      workDir: local?.workDir ?? DEFAULT_WORKDIR,
      autoStart: local?.autoStart ?? true,
      position: assigned.get(c.name) as AgentConfig['position'],
      color: local?.color ?? colorForArchetype(c.name),
      ...(local?.provider ? { provider: local.provider } : {}),
    };
  });
}
