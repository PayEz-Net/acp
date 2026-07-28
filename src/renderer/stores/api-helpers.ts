import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import { useProjectStore } from './projectStore';

let localSecretCache: string | null = null;

export async function getCachedLocalSecret(): Promise<string | null> {
  if (localSecretCache) return localSecretCache;
  if (window.electronAPI?.getLocalSecret) {
    try {
      localSecretCache = await window.electronAPI.getLocalSecret();
      return localSecretCache;
    } catch (err) {
      console.error('[API] Failed to get local secret:', err);
    }
  }
  return null;
}

export function clearSecretCache(): void {
  localSecretCache = null;
}

export function getActiveProjectId(): number | undefined {
  try {
    return useProjectStore.getState().activeProject?.id;
  } catch {
    return undefined;
  }
}

/**
 * Build an acp-api URL with automatic ?project_id= when an active project is set.
 * Handles endpoints that already contain query parameters.
 */
export function buildUrl(basePath: string, endpoint: string): string {
  const projectId = getActiveProjectId();
  const hasQuery = endpoint.includes('?');
  const sep = hasQuery ? '&' : '?';
  const projectQs = projectId !== undefined
    ? `${sep}project_id=${encodeURIComponent(String(projectId))}`
    : '';
  return `http://127.0.0.1:3001${basePath}${endpoint}${projectQs}`;
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  agentName?: string;
}

/**
 * Authenticated fetch to the local acp-api sidecar.
 * Automatically appends ?project_id= when a project is active.
 */
export async function apiRequest(basePath: string, endpoint: string, options: ApiRequestOptions = {}): Promise<Response> {
  const { method = 'GET', body, agentName } = options;
  const secret = await getCachedLocalSecret();
  const url = buildUrl(basePath, endpoint);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
  };
  if (secret) {
    headers['Authorization'] = `Bearer ${secret}`;
  }
  if (agentName) {
    headers['X-ACP-Agent'] = agentName;
  }

  return fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// --- Live-team engage (WO-ACP-LIVE-TEAM-MERGE ACP-2/ACP-6) ---
// A project's roster IS its engaged standing team's roster, read live. Teams
// are listed via the sidecar's `GET /v1/teams` bearer proxy; engagement goes
// through `POST /v1/projects/:id/teams` (the ONLY assignment path — no
// per-project membership writes exist anymore). Re-engaging over an existing
// team without `?confirm=true` → 409 ENGAGE_CONFIRM_REQUIRED carrying
// current_team / incoming_team / lost_overrides, passed through VERBATIM by
// the sidecar so the renderer can run the swap-consent dialog.

export interface StandingTeam {
  id: string | number;
  name: string;
  member_count?: number;
}

/** The 409 ENGAGE_CONFIRM_REQUIRED body (envelope-tolerant extraction). */
export interface EngageConflictInfo {
  current_team: unknown;
  incoming_team: unknown;
  lost_overrides: unknown;
}

export type EngageResult =
  | { ok: true }
  | { ok: false; conflict: EngageConflictInfo }
  | { ok: false; error: string };

/** Best-effort display name for a team-ish object from the cloud. */
export function teamDisplayName(team: unknown): string {
  if (!team || typeof team !== 'object') return 'unknown team';
  const t = team as Record<string, unknown>;
  const name = t.name ?? t.team_name ?? t.display_name;
  return typeof name === 'string' && name ? name : 'unknown team';
}

/** Envelope-tolerant team-list extraction — the sidecar/cloud may answer
 *  `{data:[…]}`, `{data:{teams:[…]}}`, or `{teams:[…]}`. Shared by
 *  fetchStandingTeams and the team-editor consumers. */
export function extractTeamList(body: any): any[] {
  return Array.isArray(body?.data?.teams)
    ? body.data.teams
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.teams)
        ? body.teams
        : [];
}

/** List standing teams (engage-picker source) via the sidecar proxy. */
export async function fetchStandingTeams(): Promise<StandingTeam[]> {
  const res = await apiRequest('/v1/teams', '');
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message || body?.message || `HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => null);
  return extractTeamList(body)
    .map((t: any) => ({
      id: t?.id ?? t?.team_id,
      name: teamDisplayName(t),
      member_count: typeof t?.member_count === 'number' ? t.member_count : undefined,
    }))
    .filter((t: StandingTeam) => t.id !== undefined && t.id !== null);
}

function pickConflictField(body: any, key: string): unknown {
  return body?.[key] ?? body?.error?.[key] ?? body?.error?.details?.[key] ?? body?.data?.[key] ?? null;
}

/**
 * Engage a standing team on a project (sidecar → cloud EngageTeam).
 * confirm=false on a project that already has a team → returns the 409
 * conflict payload verbatim for the swap-consent dialog; re-call with
 * confirm=true to execute the swap.
 */
export async function engageProjectTeam(
  projectId: number,
  teamId: string | number,
  opts: { confirm?: boolean } = {},
): Promise<EngageResult> {
  // The sidecar engage proxy requires a NUMERIC team_id (400 otherwise) —
  // normalize here, in the single choke point, so every caller (CTA picker
  // state is a string, team-editor ids may be strings) is covered.
  const id = typeof teamId === 'string' ? Number(teamId) : teamId;
  if (typeof id !== 'number' || !Number.isFinite(id)) {
    return { ok: false, error: 'Invalid team id' };
  }
  try {
    const res = await apiRequest('/v1/projects', `/${projectId}/teams${opts.confirm ? '?confirm=true' : ''}`, {
      method: 'POST',
      body: { team_id: id },
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.success !== false) return { ok: true };
    if (res.status === 409) {
      return {
        ok: false,
        conflict: {
          current_team: pickConflictField(body, 'current_team'),
          incoming_team: pickConflictField(body, 'incoming_team'),
          lost_overrides: pickConflictField(body, 'lost_overrides'),
        },
      };
    }
    const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
    return { ok: false, error: msg };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
