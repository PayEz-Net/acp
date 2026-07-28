/**
 * api.ts
 * Thin fetch wrapper for the local acp-api sidecar.
 * Uses the same auth + ?project_id= pattern as other renderer stores.
 *
 * Base prefix: `/v1/teams` — the canonical sidecar bearer-proxy for the
 * cloud's relational standing-team routes (WO-ACP-LIVE-TEAM-MERGE ACP-6;
 * replaces the never-mounted `/v1/agent-teams*`). Project assignment rides
 * the EngageTeam route (POST /v1/projects/:id/teams) — the SINGLE
 * assignment path; there is no per-project membership write anymore.
 */

import { apiRequest, engageProjectTeam, type EngageResult } from '../../stores/api-helpers';

async function req<T>(basePath: string, endpoint: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const res = await apiRequest(basePath, endpoint, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  // Teams
  listTeams: () => req<{ data: any[] }>('/v1/teams', ''),
  createTeam: (name: string) =>
    req<{ data: any }>('/v1/teams', '', {
      method: 'POST',
      body: { name },
    }),
  renameTeam: (id: string, name: string) =>
    req<{ data: any }>('/v1/teams', `/${id}`, {
      method: 'PUT',
      body: { name },
    }),
  deleteTeam: (id: string) =>
    req<{ data: any }>('/v1/teams', `/${id}`, {
      method: 'DELETE',
    }),

  // Instances
  listInstances: (teamId: string) =>
    req<{ data: any[] }>('/v1/teams', `/${teamId}/instances`),
  addInstance: (teamId: string, payload: unknown) =>
    req<{ data: any }>('/v1/teams', `/${teamId}/instances`, {
      method: 'POST',
      body: payload,
    }),
  updateInstance: (teamId: string, instId: string, payload: unknown) =>
    req<{ data: any }>('/v1/teams', `/${teamId}/instances/${instId}`, {
      method: 'PUT',
      body: payload,
    }),
  removeInstance: (teamId: string, instId: string) =>
    req<{ data: any }>('/v1/teams', `/${teamId}/instances/${instId}`, {
      method: 'DELETE',
    }),

  // Projects (team assignment = EngageTeam, the only path). A 409
  // ENGAGE_CONFIRM_REQUIRED comes back as `{ ok:false, conflict }` — the
  // caller runs the swap-consent dialog and re-calls with confirm=true.
  // There is deliberately NO unassign: swapping teams = engaging another.
  getProject: (id: number) => req<{ data: any }>('/v1/projects', `/${id}`),
  assignTeam: (projectId: number, teamId: string, opts?: { confirm?: boolean }): Promise<EngageResult> =>
    engageProjectTeam(projectId, teamId, opts),
};
