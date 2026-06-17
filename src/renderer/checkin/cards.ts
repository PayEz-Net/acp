import type { StandupRound, StandupReport } from './types';

/** A board cell: an expected agent and their report (null = not reported yet). */
export interface AgentCard {
  name: string;
  report: StandupReport | null;
}

/**
 * The card list for a round = one per expected agent (plus any reporter not in
 * expected_agents), each matched to its report by agent_name. Shared by the
 * board and the history drill-down so the "who's expected vs who reported"
 * rule lives in exactly one place.
 */
export function roundCards(round: StandupRound): AgentCard[] {
  const byName = new Map(round.reports.map((r) => [r.agent_name, r]));
  const names = Array.from(
    new Set([
      ...round.expected_agents.map((a) => a.agent_name),
      ...round.reports.map((r) => r.agent_name),
    ]),
  );
  return names.map((name) => ({ name, report: byName.get(name) ?? null }));
}
