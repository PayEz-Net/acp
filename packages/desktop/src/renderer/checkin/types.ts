/**
 * Team Check-in (Standup W3) — wire contract.
 *
 * Canonical field set, pinned with DotNetPert (msgs 967 / 969) + BAPert (962):
 * spec §5.1, snake_case END-TO-END (API -> SSE -> UI). NO entryType/event_type
 * or agentName drift — that drift is exactly what this wave kills.
 *
 * The board reads DURABLE rounds via the nested project-scoped routes and
 * NEVER falls back to the in-memory activity ring (D2 + Aurum sharpening #2 —
 * a durable read failure FAILS LOUD; empty-state only when there genuinely is
 * no round).
 *
 * Read routes (DotNetPert W1, nested per BAPert #969 — same family as
 * /v1/projects/{id}/kanban|team|lifecycle):
 *   GET /v1/projects/{project_id}/standup/rounds/current    -> { round: StandupRound | null }
 *   GET /v1/projects/{project_id}/standup/rounds            -> { rounds: StandupRound[] }  (newest first, paged)
 *   GET /v1/projects/{project_id}/standup/rounds/{round_id} -> { round: StandupRound }
 * Each round carries reports[] inline (board reads round + reports in one shot).
 * project_id is explicit, server-validated for entitlement (403 on foreign),
 * and sourced from the active-project source-of-truth chain (NOT electron-store).
 *
 * SSE (DotNetPert W2): event "standup_report" { round_id, report },
 * event "standup_round" { round }.
 */

export type RoundStatus = 'open' | 'closed';
export type ReportState = 'reported' | 'pending' | 'absent';
export type RoundTrigger = 'manual' | 'scheduled';

/** One agent's report within a round (spec §5.1, verbatim snake_case). */
export interface StandupReport {
  agent_id: number;
  agent_name: string;
  /** "what I completed since the last check-in" */
  did_md: string;
  /** "what I'm doing next" */
  next_md: string;
  /** "any blockers" — nullable */
  blockers_md?: string | null;
  /**
   * FK kanban_tasks (nullable) — rendered as task chips on the card.
   * Element type follows kanban_tasks.task_id (ULID string in acp-api);
   * confirm-with-DotNetPert if W1 serializes these numeric instead.
   */
  task_refs?: string[] | null;
  /** ISO timestamp; set when state === 'reported'. */
  reported_at: string;
  state: ReportState;
}

/** A standup round = the durable snapshot unit (spec §5.1, verbatim). */
export interface StandupRound {
  round_id: string;
  project_id: number;
  started_at: string;
  trigger: RoundTrigger;
  /** the dev who called it */
  called_by: string;
  /** the project's team at call time */
  expected_agents: string[];
  reports: StandupReport[];
  status: RoundStatus;
  /** optional roll-up — D3 is LATER, so this is left UNRENDERED in v1. */
  summary_md?: string | null;
}

// ── Read-endpoint response envelopes ──────────────────────────────────────
export interface CurrentRoundResponse {
  round: StandupRound | null;
}
export interface RoundsResponse {
  rounds: StandupRound[];
}
export interface RoundResponse {
  round: StandupRound;
}

// ── SSE payloads (W2) — same snake_case contract as the read wire ──────────
export interface StandupReportEvent {
  round_id: string;
  report: StandupReport;
}
export interface StandupRoundEvent {
  round: StandupRound;
}
