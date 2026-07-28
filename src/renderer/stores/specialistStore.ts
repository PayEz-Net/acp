import { create } from 'zustand';
import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import { useAppStore } from './appStore';
import { useProjectStore } from './projectStore';

// --- Types ---

export interface SpecialistAgent {
  id: number;
  name: string;
  displayName: string | null;
  description: string | null;
  role: string | null;
  model: string | null;
  expertiseJson: string | null;
  agentType: string | null;
  isActive: boolean;
  startupOrder: number;
  basePrompt: string | null;
  isCanonical: boolean;
}

export interface RosterEntry extends SpecialistAgent {
  // Local UI state for the roster
  position: number;
}

// --- API helpers ---

async function acpRequest(path: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
  const { method = 'GET', body } = options;
  const secret = await window.electronAPI.getLocalSecret();
  const projectId = useProjectStore.getState().activeProject?.id;
  const qs = projectId !== undefined ? `?project_id=${encodeURIComponent(String(projectId))}` : '';
  return fetch(`http://127.0.0.1:3001${path}${qs}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// --- Store ---

interface SpecialistStore {
  catalog: SpecialistAgent[];
  roster: RosterEntry[];
  loading: boolean;
  error: string | null;
  searchQuery: string;
  filterCategory: string | null;

  setSearchQuery: (q: string) => void;
  setFilterCategory: (c: string | null) => void;

  fetchCatalog: () => Promise<void>;
  fetchRoster: (projectId: number) => Promise<void>;

  engageAgent: (agent: SpecialistAgent) => void;
  disengageAgent: (agentId: number) => void;
  reorderRoster: (oldIndex: number, newIndex: number) => void;

  saveRosterOrder: (projectId: number) => Promise<boolean>;
}

export function isCanonical(agent: Pick<SpecialistAgent, 'isCanonical'>): boolean {
  return agent.isCanonical;
}

export function modelTierHint(model: string | null): 'opus' | 'sonnet' | 'byos' | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('claude') || m.includes('gpt') || m.includes('kimi')) return 'byos';
  return null;
}

export const useSpecialistStore = create<SpecialistStore>((set, get) => ({
  catalog: [],
  roster: [],
  loading: false,
  error: null,
  searchQuery: '',
  filterCategory: null,

  setSearchQuery: (q) => set({ searchQuery: q }),
  setFilterCategory: (c) => set({ filterCategory: c }),

  fetchCatalog: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loading: true, error: null });
    try {
      const res = await acpRequest('/v1/agents/startup-config');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const agents: SpecialistAgent[] = Array.isArray(data.data?.agents)
        ? data.data.agents
        : Array.isArray(data.data)
          ? data.data
          : [];
      set({ catalog: agents, loading: false });
    } catch (err) {
      console.error('[Specialists] Failed to fetch catalog:', err);
      set({ loading: false, error: 'Failed to load specialist catalog' });
    }
  },

  fetchRoster: async (projectId) => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loading: true, error: null });
    try {
      const res = await acpRequest(`/v1/projects/${projectId}/team`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const team: Array<{ agent_id: number; agent_name: string; agent_display_name: string | null; role: string | null }> =
        Array.isArray(data.data?.team) ? data.data.team : Array.isArray(data.data) ? data.data : [];

      // Map team members back to full SpecialistAgent shapes from catalog
      const { catalog } = get();
      const roster: RosterEntry[] = team.map((t, idx) => {
        const full = catalog.find((c) => c.id === t.agent_id);
        return {
          ...(full ?? {
            id: t.agent_id,
            name: t.agent_name,
            displayName: t.agent_display_name,
            description: null,
            role: t.role,
            model: null,
            expertiseJson: null,
            agentType: null,
            isActive: true,
            startupOrder: 0,
            basePrompt: null,
            isCanonical: false,
          }),
          position: idx,
        };
      });
      set({ roster, loading: false });
    } catch (err) {
      console.error('[Specialists] Failed to fetch roster:', err);
      set({ loading: false, error: 'Failed to load specialist bench' });
    }
  },

  engageAgent: (agent) => {
    const { roster } = get();
    if (roster.some((r) => r.id === agent.id)) return;
    set({ roster: [...roster, { ...agent, position: roster.length }] });
  },

  disengageAgent: (agentId) => {
    const { roster } = get();
    const filtered = roster.filter((r) => r.id !== agentId);
    // Re-index positions
    const reindexed = filtered.map((r, idx) => ({ ...r, position: idx }));
    set({ roster: reindexed });
  },

  reorderRoster: (oldIndex, newIndex) => {
    const { roster } = get();
    const item = roster[oldIndex];
    if (!item) return;
    const next = [...roster];
    next.splice(oldIndex, 1);
    next.splice(newIndex, 0, item);
    set({ roster: next.map((r, idx) => ({ ...r, position: idx })) });
  },

  saveRosterOrder: async (projectId) => {
    if (!useAppStore.getState().backendAvailable) return false;
    const { roster } = get();
    const order = roster.map((r) => r.id);
    try {
      const res = await acpRequest('/v1/agents/startup-order', {
        method: 'PUT',
        body: { project_id: projectId, order },
      });
      return res.ok;
    } catch (err) {
      console.error('[Specialists] Failed to save roster order:', err);
      return false;
    }
  },
}));
