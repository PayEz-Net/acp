/**
 * api.ts
 * Thin fetch wrapper for the local acp-api sidecar.
 * Uses the same auth + ?project_id= pattern as other renderer stores.
 */

import { apiRequest } from '../../stores/api-helpers';

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
  listTeams: () => req<{ data: any[] }>('/v1/agent-teams', ''),
  createTeam: (name: string) =>
    req<{ data: any }>('/v1/agent-teams', '', {
      method: 'POST',
      body: { name },
    }),
  renameTeam: (id: string, name: string) =>
    req<{ data: any }>('/v1/agent-teams', `/${id}`, {
      method: 'PUT',
      body: { name },
    }),
  deleteTeam: (id: string) =>
    req<{ data: any }>('/v1/agent-teams', `/${id}`, {
      method: 'DELETE',
    }),

  // Instances
  listInstances: (teamId: string) =>
    req<{ data: any[] }>('/v1/agent-teams', `/${teamId}/instances`),
  addInstance: (teamId: string, payload: unknown) =>
    req<{ data: any }>('/v1/agent-teams', `/${teamId}/instances`, {
      method: 'POST',
      body: payload,
    }),
  updateInstance: (teamId: string, instId: string, payload: unknown) =>
    req<{ data: any }>('/v1/agent-teams', `/${teamId}/instances/${instId}`, {
      method: 'PUT',
      body: payload,
    }),
  removeInstance: (teamId: string, instId: string) =>
    req<{ data: any }>('/v1/agent-teams', `/${teamId}/instances/${instId}`, {
      method: 'DELETE',
    }),

  // Projects (team assignment)
  getProject: (id: number) => req<{ data: any }>('/v1/projects', `/${id}`),
  assignTeam: (projectId: number, teamId: string) =>
    req<{ data: any }>('/v1/projects', `/${projectId}/team-assignment`, {
      method: 'POST',
      body: { team_id: teamId },
    }),
  unassignTeam: (projectId: number) =>
    req<{ data: any }>('/v1/projects', `/${projectId}/team-assignment`, {
      method: 'DELETE',
    }),
};
