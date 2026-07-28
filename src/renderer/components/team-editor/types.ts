// Team Editor — shared types
// Path: src/renderer/components/team-editor/types.ts

export interface AgentArchetype {
  id: string;
  name: string;
  displayName: string;
  role: string;
  basePrompt: string;
  defaultPersonality: string;
}

export interface AgentInstance {
  id: string;
  teamId: string;
  archetypeId: string;
  // The member's canonical agent name (#207 one-name: team_unique_name /
  // team_display_name are GONE — a member's name IS the canonical agent name).
  name: string;
  displayName: string;
  role: string;
  identityPrompt: string;
  expertiseTags: string[];
  personalityPreset: string;
  rolePreset: string;
  sortOrder: number;
  // v0.3 skill chips (frontend-driven for now)
  skills?: string[];
}

export interface Team {
  id: string;
  name: string;
  displayName?: string;
  isActive: boolean;
  ownerUserId?: number;
  createdAt: string;
  updatedAt?: string;
  instances: AgentInstance[];
}

/** Project shape as seen by the Team Editor (lightweight). */
export interface TeamEditorProject {
  id: number;
  name: string;
  // Live-team model: the engaged standing team (null = no team engaged).
  engaged_team_id?: number | string | null;
  engaged_team_name?: string | null;
}

export interface TeamAssignment {
  teamId: string;
  assignedAt: string;
}

// Form state for create/edit agent instance
export interface AgentInstanceFormData {
  archetypeId: string;
  name: string;
  displayName: string;
  role: string;
  identityPrompt: string;
  expertiseTags: string;
  personalityPreset: string;
  rolePreset: string;
  sortOrder: number;
  // v0.3 skill chips
  skills: string[];
}
