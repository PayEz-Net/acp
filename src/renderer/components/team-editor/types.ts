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
  teamUniqueName: string;
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
  assignedTeamId?: string;
}

export interface TeamAssignment {
  teamId: string;
  assignedAt: string;
}

// Form state for create/edit agent instance
export interface AgentInstanceFormData {
  archetypeId: string;
  teamUniqueName: string;
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
