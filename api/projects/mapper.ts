/**
 * Wave 2 + post-rename: cloud `ProjectDto` → wire shape.
 *
 * Three-state focus-pointer enum is `stored | unset | empty` (per spec §5.4):
 *   stored — developer_current_project row exists, project loaded normally.
 *   unset  — no row, but developer has ≥1 project — picker prompts.
 *   empty  — developer has zero projects — create-CTA pointing at idealvibe.
 * Cloud no longer returns a first-project hint when the row is absent — it
 * returns null + state='unset' and the FE prompts the user to pick. Memory
 * rule `feedback_no_unjustified_fallback` enforces.
 *
 * Cloud DTO reference (from DotNetPert wave1-deploy-nextpert.json):
 *   { id, owner_user_id, name, description: string|null, settings: unknown|null,
 *     is_active: boolean, created_at, updated_at: string|null, member_count }
 *
 * FE consumer reference (acp-desktop/src/renderer/stores/projectStore.ts):
 *   { id, name, description?, status: 'active'|'archived'|'completed',
 *     agentProvider?, created_at, updated_at }
 *
 * Drift-prone fields:
 *   - `description: null` from cloud → `undefined` on wire (FE expects optional)
 *   - `updated_at: null` from cloud → falls back to `created_at` (FE type is non-optional)
 *   - `agentProvider` — cloud has no analogue; mapper omits the field entirely.
 */

export type CurrentProjectState = 'stored' | 'unset' | 'empty';

export interface CloudProjectDto {
  id: number;
  owner_user_id: number;
  name: string;
  description: string | null;
  settings: unknown | null;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
  member_count: number;
}

export interface CloudProjectMemberDto {
  id: number;
  project_id: number;
  user_id: number;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  invited_by: number | null;
  joined_at: string;
  is_active: boolean;
}

export interface MappedProject {
  id: number;
  owner_user_id: number;
  name: string;
  description?: string;
  status: 'active';
  is_active: boolean;
  created_at: string;
  updated_at: string;
  member_count: number;
}

export function mapCloudProject(p: CloudProjectDto): MappedProject {
  return {
    id: p.id,
    owner_user_id: p.owner_user_id,
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    status: 'active',
    is_active: p.is_active,
    created_at: p.created_at,
    updated_at: p.updated_at ?? p.created_at,
    member_count: p.member_count,
  };
}

/**
 * Pull `data.projects` out of the cloud envelope and map.
 */
export function extractAndMapList(cloudPayload: unknown): MappedProject[] {
  const data = (cloudPayload as any)?.data;
  const projects = data?.projects;
  if (!Array.isArray(projects)) return [];
  return projects.map(mapCloudProject);
}

/**
 * Pull `data.{current_project_id, project, current_project_state}` out of
 * the cloud envelope (`/v1/users/me/current-project`).
 *
 * `current_project_id` is forced to null when state is 'unset' or 'empty' —
 * the FE first-boot-prompt branch depends on the absence of a project_id
 * to render the picker. We do NOT pass through any cloud-supplied
 * fallback-first hint per `feedback_no_unjustified_fallback`.
 */
export function extractAndMapCurrent(cloudPayload: unknown): {
  current_project_id: number | null;
  project: MappedProject | null;
  current_project_state: CurrentProjectState;
} {
  const data = (cloudPayload as any)?.data ?? {};

  const stateRaw =
    typeof data.current_project_state === 'string' ? data.current_project_state : '';
  const current_project_state: CurrentProjectState =
    stateRaw === 'stored' ? 'stored'
    : stateRaw === 'empty' ? 'empty'
    : 'unset';

  const project =
    current_project_state === 'stored' && data.project ? mapCloudProject(data.project) : null;
  const current_project_id =
    current_project_state === 'stored' && typeof data.current_project_id === 'number'
      ? data.current_project_id
      : null;

  return { current_project_id, project, current_project_state };
}

/**
 * For `GET /v1/projects/:id` — returns the project + its members. Members
 * pass through with no shape change (FE may consume directly).
 */
export function extractAndMapDetail(cloudPayload: unknown): {
  project: MappedProject | null;
  members: CloudProjectMemberDto[];
} {
  const data = (cloudPayload as any)?.data ?? {};
  const project = data.project ? mapCloudProject(data.project) : null;
  const members = Array.isArray(data.members) ? data.members : [];
  return { project, members };
}
