import { create } from 'zustand';
import { StandupRound, StandupBlocker, BlockerTriageState } from '@shared/types';
import { useAppStore } from './appStore';
import { apiRequest } from './api-helpers';

// Durable standup ROUNDS (#120 W4) — distinct from the flat StandupEntry log.
// Reads the project-nested cloud surface via the acp-api 3001 proxy
// (/v1/projects/{id}/standup/rounds*), which forwards the FE-shaped
// {round}/{rounds} body VERBATIM. The board reads a round + its reports[] in one
// shot. NO SILENT FALLBACK: a durable-round read failure FAILS LOUD (sets error),
// it never degrades to the flat entries or an in-memory ring (Aurum #2).
async function roundsRequest(
  projectId: number,
  endpoint: string,
  options: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {},
): Promise<Response> {
  return apiRequest(`/v1/projects/${projectId}/standup`, endpoint, options);
}

// The proxy is verbatim, so the body is the raw cloud shape ({round}/{rounds}).
// Read defensively in case a deployment wraps it in the acp-api {success,data}.
function unwrap<T>(json: any, key: 'round' | 'rounds'): T {
  const root = json?.data ?? json;
  return root?.[key] ?? null;
}

interface StandupRoundsStore {
  currentRound: StandupRound | null;
  history: StandupRound[];
  loading: boolean;
  error: string | null;
  acting: boolean;

  fetchCurrent: (projectId: number) => Promise<void>;
  fetchHistory: (projectId: number) => Promise<void>;
  callStandup: (projectId: number) => Promise<boolean>;
  closeRound: (projectId: number, roundId: string) => Promise<boolean>;
  triageBlocker: (
    projectId: number,
    roundId: string,
    blockerId: string,
    state: BlockerTriageState,
  ) => Promise<boolean>;
}

export const useStandupRoundsStore = create<StandupRoundsStore>((set, get) => ({
  currentRound: null,
  history: [],
  loading: false,
  error: null,
  acting: false,

  fetchCurrent: async (projectId) => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loading: true, error: null });
    try {
      const res = await roundsRequest(projectId, '/rounds/current');
      if (!res.ok) throw new Error(`current round read failed (${res.status})`);
      const json = await res.json();
      set({ currentRound: unwrap<StandupRound | null>(json, 'round'), loading: false });
    } catch (err) {
      // Fail loud — surface the read failure, do NOT fall back to flat entries.
      console.error('[StandupRounds] fetchCurrent failed:', err);
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to read current standup round' });
    }
  },

  fetchHistory: async (projectId) => {
    if (!useAppStore.getState().backendAvailable) return;
    try {
      const res = await roundsRequest(projectId, '/rounds');
      if (!res.ok) throw new Error(`rounds history read failed (${res.status})`);
      const json = await res.json();
      const rounds = unwrap<StandupRound[]>(json, 'rounds') || [];
      set({ history: Array.isArray(rounds) ? rounds : [] });
    } catch (err) {
      console.error('[StandupRounds] fetchHistory failed:', err);
      set({ error: err instanceof Error ? err.message : 'Failed to read standup history' });
    }
  },

  callStandup: async (projectId) => {
    if (!useAppStore.getState().backendAvailable) return false;
    set({ acting: true, error: null });
    try {
      const res = await roundsRequest(projectId, '/rounds', { method: 'POST', body: { trigger: 'manual' } });
      if (!res.ok) throw new Error(`call standup failed (${res.status})`);
      set({ acting: false });
      await get().fetchCurrent(projectId);
      return true;
    } catch (err) {
      console.error('[StandupRounds] callStandup failed:', err);
      set({ acting: false, error: err instanceof Error ? err.message : 'Failed to call standup' });
      return false;
    }
  },

  closeRound: async (projectId, roundId) => {
    if (!useAppStore.getState().backendAvailable) return false;
    set({ acting: true, error: null });
    try {
      const res = await roundsRequest(projectId, `/rounds/${roundId}/close`, { method: 'POST' });
      if (!res.ok) throw new Error(`close round failed (${res.status})`);
      set({ acting: false });
      await get().fetchCurrent(projectId);
      await get().fetchHistory(projectId);
      return true;
    } catch (err) {
      console.error('[StandupRounds] closeRound failed:', err);
      set({ acting: false, error: err instanceof Error ? err.message : 'Failed to close round' });
      return false;
    }
  },

  // #121 W5 — triage a blocker (open -> acknowledged | resolved). EXPLICIT human
  // disposition (Aurum 2619): only ever fired by a deliberate click, never on view.
  triageBlocker: async (projectId, roundId, blockerId, state) => {
    if (!useAppStore.getState().backendAvailable) return false;
    set({ acting: true, error: null });
    try {
      const res = await roundsRequest(projectId, `/rounds/${roundId}/blockers/${blockerId}/triage`, {
        method: 'POST',
        body: { triage_state: state },
      });
      if (!res.ok) throw new Error(`triage failed (${res.status})`);
      set({ acting: false });
      await get().fetchCurrent(projectId);
      return true;
    } catch (err) {
      console.error('[StandupRounds] triageBlocker failed:', err);
      set({ acting: false, error: err instanceof Error ? err.message : 'Failed to triage the blocker' });
      return false;
    }
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// W4 actionable-loop derivations (pure, deterministic from the round contract).
// These encode the card #120 GAP rulings verbatim so the board never re-derives.
// ─────────────────────────────────────────────────────────────────────────────

function hasBlocker(blockers_md?: string | null): boolean {
  return !!(blockers_md && blockers_md.trim());
}

/**
 * M3 — quiet-when-calm. A round is calm when zero reports carry a non-null
 * blocker; the board renders a collapsed "all clear — N filed" instead of the
 * blocker-first layout. (Calm is about blockers only; completeness is M4.)
 */
export function isCalmRound(round: StandupRound | null): boolean {
  if (!round) return false;
  return !round.reports.some((r) => hasBlocker(r.blockers_md));
}

export type BlockerDiff = 'new' | 'cleared' | 'stalled' | 'none';

/**
 * M2 — agent-level blocker diff, keyed by agent_id across current vs previous
 * round. GAP-3 RULING: "cleared" requires the agent REPORTED this round AND the
 * blocker is absent from THAT report; a silent agent (state !== 'reported') is
 * NOT cleared — it carries STALLED if it had a blocker before. Silence != resolution.
 */
export function blockerDiffFor(
  current: StandupRound | null,
  previous: StandupRound | null,
  agentId: number,
): BlockerDiff {
  const cur = current?.reports.find((r) => r.agent_id === agentId);
  const prv = previous?.reports.find((r) => r.agent_id === agentId);
  const curHas = hasBlocker(cur?.blockers_md);
  const prvHas = hasBlocker(prv?.blockers_md);
  const curReported = cur?.state === 'reported';

  if (curHas && prvHas) return 'stalled'; // blocked 2+ rounds running
  if (curHas && !prvHas) return 'new';
  if (!curHas && prvHas) {
    // Had a blocker last round. Cleared ONLY if they actually reported clean;
    // a silent/absent agent is still stalled (GAP-3: silence != resolution).
    return curReported ? 'cleared' : 'stalled';
  }
  return 'none';
}

export type RoundDoneState = 'no-team' | 'in-progress' | 'complete' | 'closed-partial';

/**
 * M4 — basic done-state, NOT triage-gated. GAP-1 RULING: a zero-expected round
 * is a DISTINCT "no team / N/A" state, never COMPLETE. Otherwise: complete =
 * status closed AND every expected agent filed (state === 'reported'); a closed
 * round missing reports is honestly "closed-partial", not complete.
 */
export function roundDoneState(round: StandupRound | null): RoundDoneState {
  if (!round) return 'in-progress';
  if (round.expected_agents.length === 0) return 'no-team'; // GAP-1
  const reported = new Set(
    round.reports.filter((r) => r.state === 'reported').map((r) => r.agent_id),
  );
  const allFiled = round.expected_agents.every((a) => reported.has(a.agent_id));
  if (round.status === 'closed') return allFiled ? 'complete' : 'closed-partial';
  return 'in-progress';
}

/** Count of expected agents who have filed (state === 'reported'). */
export function filedCount(round: StandupRound | null): { filed: number; expected: number } {
  if (!round) return { filed: 0, expected: 0 };
  const reported = round.reports.filter((r) => r.state === 'reported').length;
  return { filed: reported, expected: round.expected_agents.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// #121 W5 — structured-blocker derivations (keyed by stable blocker_id). These
// supersede the W4 free-text agent-level diff when structured blockers exist;
// when report.blockers is absent (pre-W5 / not deployed), the board falls back to
// the W4 blockers_md path — no hard dependency on the W5 backend being live.
// ─────────────────────────────────────────────────────────────────────────────

/** Every structured blocker in a round (across all reports), or [] if none. */
export function roundBlockers(round: StandupRound | null): StandupBlocker[] {
  if (!round) return [];
  return round.reports.flatMap((r) => r.blockers ?? []);
}

/** True if the round carries any structured blockers (i.e. W5 data is present). */
export function hasStructuredBlockers(round: StandupRound | null): boolean {
  return roundBlockers(round).length > 0;
}

/** Triage-gate (W5): a round can't close 'done' while any blocker is still "open". */
export function openBlockerCount(round: StandupRound | null): number {
  return roundBlockers(round).filter((b) => b.triage_state === 'open').length;
}

export type BlockerByIdDiff = 'new' | 'carried' | 'cleared';

/**
 * M2 (W5) — per-blocker diff keyed by the STABLE blocker_id across rounds. Far
 * more robust than the W4 free-text agent-level approximation:
 *  - new:     this blocker_id was absent in the previous round.
 *  - carried: present in both rounds and still not resolved (the STALLED signal).
 *  - cleared: present last round, and now resolved or gone.
 */
export function blockerByIdDiff(
  blocker: StandupBlocker,
  previous: StandupRound | null,
): BlockerByIdDiff {
  const prev = roundBlockers(previous).find((b) => b.blocker_id === blocker.blocker_id);
  if (!prev) return 'new';
  if (blocker.triage_state === 'resolved') return 'cleared';
  return 'carried';
}
