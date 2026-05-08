/**
 * DRAFT — Wave 2 (gated on QAPert AC-pass).
 * Target path: acp-api/api/projects/mapper.ts
 *
 * REVISED 2026-05-08 post-QAPert: enum is now `stored | unset | empty`
 * (no `fallback-first`). Per spec §5.4, cloud no longer returns a
 * first-project hint when the developer has projects but no
 * developer_active_project row — it returns null + state='unset' and the
 * FE prompts the user to pick. No silent auto-load. Memory rule
 * `feedback_no_unjustified_fallback` enforces.
 *
 * Cloud `ProjectDto` (from vibe-publicapi `/v1/projects`) → wire shape the
 * desktop renderer's `projectStore.Project` consumes. Identical-name fields
 * pass through; cloud `is_active` collapses to FE `status: 'active'` because
 * acp-api always queries `?activeOnly=true`.
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
 *     FE `applyProjectAgentProvider` becomes a no-op (memory rule
 *     `feedback_runtime_choice_vs_platform_llm`: runtime is config-driven, not
 *     project-driven). Confirm-and-delete in a follow-up sweep per workorder §1a.
 */

export type ActiveProjectState = 'stored' | 'unset' | 'empty';

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
 * Pull `data.{active_project_id, project, active_project_state}` out of the
 * cloud envelope.
 *
 * Compatibility: while cloud is mid-revision, accept either the new
 * `active_project_state` field OR the old `source` field with a translation
 * map. Once Wave 1 redeploys with the locked enum, the legacy branch is
 * unreachable — leave it for one release cycle and prune in a follow-up.
 *
 * Spec §5.4 enum: 'stored' | 'unset' | 'empty'.
 *
 * `active_project_id` is forced to null when state is 'unset' or 'empty' —
 * the FE first-boot-prompt branch depends on the absence of a project_id
 * to render the picker. We do NOT pass through any cloud-supplied
 * fallback-first hint per `feedback_no_unjustified_fallback`.
 */
export function extractAndMapActive(cloudPayload: unknown): {
  active_project_id: number | null;
  project: MappedProject | null;
  active_project_state: ActiveProjectState;
} {
  const data = (cloudPayload as any)?.data ?? {};

  const stateRaw =
    (typeof data.active_project_state === 'string' && data.active_project_state) ||
    (typeof data.source === 'string' && data.source) ||
    '';
  const active_project_state: ActiveProjectState =
    stateRaw === 'stored' ? 'stored'
    : stateRaw === 'empty' ? 'empty'
    : stateRaw === 'unset' || stateRaw === 'fallback-first' ? 'unset'
    : 'unset';

  const project =
    active_project_state === 'stored' && data.project ? mapCloudProject(data.project) : null;
  const active_project_id =
    active_project_state === 'stored' && typeof data.active_project_id === 'number'
      ? data.active_project_id
      : null;

  return { active_project_id, project, active_project_state };
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
