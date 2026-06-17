/**
 * Team Check-in (W3) read-client.
 *
 * Reads DURABLE rounds via the nested project-scoped routes (DotNetPert W1,
 * locked #967/#969). project_id is sourced from the active-project chain
 * (projectStore.activeProject — server-hydrated, NOT electron-store) and
 * apiRequest scopes the call.
 *
 * FAIL LOUD: a non-OK read THROWS with the server's message — the board
 * surfaces it and never falls back to the in-memory activity ring (D2 +
 * Aurum sharpening #2). Empty-state (null / []) is returned ONLY when there
 * is no active project or the server genuinely has no round yet.
 */

import { apiRequest, getActiveProjectId } from '../stores/api-helpers';
import type {
  StandupRound,
  CurrentRoundResponse,
  RoundsResponse,
  RoundResponse,
} from './types';

const PROJECTS_BASE = '/v1/projects';

async function readOrThrow<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    let detail = String(res.status);
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.message || detail;
    } catch {
      /* keep the status code */
    }
    throw new Error(`Couldn't load ${what} (${detail})`);
  }
  return res.json() as Promise<T>;
}

/**
 * The current open round (or most-recent closed). Returns null when the
 * project has no rounds yet (clean empty-state) or no project is active.
 */
export async function fetchCurrentRound(): Promise<StandupRound | null> {
  const projectId = getActiveProjectId();
  if (projectId === undefined) return null;
  const res = await apiRequest(PROJECTS_BASE, `/${projectId}/standup/rounds/current`);
  const data = await readOrThrow<CurrentRoundResponse>(res, 'the current check-in');
  return data.round ?? null;
}

/** Past rounds, newest first. Empty array when none / no active project. */
export async function fetchRoundHistory(): Promise<StandupRound[]> {
  const projectId = getActiveProjectId();
  if (projectId === undefined) return [];
  const res = await apiRequest(PROJECTS_BASE, `/${projectId}/standup/rounds`);
  const data = await readOrThrow<RoundsResponse>(res, 'check-in history');
  return data.rounds ?? [];
}

/** One round by id. */
export async function fetchRound(roundId: string): Promise<StandupRound> {
  const projectId = getActiveProjectId();
  if (projectId === undefined) {
    throw new Error('No active project — cannot load a check-in round.');
  }
  const res = await apiRequest(PROJECTS_BASE, `/${projectId}/standup/rounds/${encodeURIComponent(roundId)}`);
  const data = await readOrThrow<RoundResponse>(res, 'the check-in round');
  return data.round;
}

/**
 * Open a new round ("Call standup") — the server snapshots the team and
 * notifies each agent (DotNetPert's W2 capture loop). Returns the opened round.
 *
 * Endpoint CONFIRMED live (DotNetPert #1046, commit 45c9c2c7a): POST the nested
 * rounds collection. Body carries the trigger (§5.1); agent_id/name are never
 * read from the body. Opening is dev-initiated (not agent-gated); filing
 * reports is agent-only (S8a 403 AGENT_REQUIRED). Fail-loud on a non-OK open.
 */
export async function openRound(): Promise<StandupRound> {
  const projectId = getActiveProjectId();
  if (projectId === undefined) {
    throw new Error('No active project — select a project before calling standup.');
  }
  const res = await apiRequest(PROJECTS_BASE, `/${projectId}/standup/rounds`, {
    method: 'POST',
    body: { trigger: 'manual' },
  });
  const data = await readOrThrow<RoundResponse>(res, 'the new check-in round');
  return data.round;
}
