/**
 * Cloud `Agent` → ACP-side normalized shape.
 *
 * Per spec §6.1 the renderer applies local prefs (color/position/workDir/
 * provider). The mapper's job is just to normalize the wire shape coming
 * back from the cloud agentmail/agents endpoint into the camelCased fields
 * the renderer's reconcile step expects.
 *
 * Cloud shape (from PayEz.Vibe.Public.Api/Controllers/V1/AgentMailController.cs):
 *   { id, name, display_name, description?, is_active, tenant_id?, created_at,
 *     identity_prompt?, role_md?, ... }
 *
 * The renderer treats the result as `MappedAgent` and merges with
 * `agentPrefs` keyed by `name` to produce the final `AgentConfig[]`.
 */

export interface CloudAgent {
  id: number;
  name: string;
  display_name?: string;
  description?: string;
  is_active?: boolean;
  tenant_id?: string;
  created_at?: string;
  // Inline profile fields are ignored for grid rendering.
  [k: string]: unknown;
}

export interface MappedAgent {
  id: number;
  name: string;
  displayName: string;
  description: string;
  isActive: boolean;
  agentType: 'team';
}

export function mapCloudAgent(a: CloudAgent): MappedAgent {
  return {
    id: a.id,
    name: a.name,
    displayName: a.display_name || a.name,
    description: a.description ?? '',
    isActive: a.is_active !== false,
    agentType: 'team',
  };
}

/**
 * Pull the agents array out of the cloud envelope and map each one. The
 * cloud responds with the standard envelope `{ success, data: { agents } }`.
 */
export function extractAndMap(cloudPayload: unknown): MappedAgent[] {
  const data = (cloudPayload as any)?.data;
  const agents = data?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.map(mapCloudAgent);
}
