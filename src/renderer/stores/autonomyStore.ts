import { create } from 'zustand';
import { AutonomyStatus, StandupEntry, StandupFilters } from '@shared/types';
import { useAppStore } from './appStore';

interface AutonomyStore {
  // State
  status: AutonomyStatus | null;
  standupEntries: StandupEntry[];
  escalations: StandupEntry[];
  filters: StandupFilters;
  loading: boolean;
  error?: string;

  // Actions
  fetchStatus: () => Promise<void>;
  fetchStandup: (agent?: string, type?: string) => Promise<void>;
  startAutonomy: (config: { specId?: number; maxRuntimeHours?: number; stopCondition?: string }) => Promise<boolean>;
  stopAutonomy: () => Promise<boolean>;
  updateFromSse: (data: Record<string, unknown>) => void;
  setFilters: (filters: Partial<StandupFilters>) => void;
}

async function autonomyRequest(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
  const { method = 'GET', body } = options;
  const secret = await window.electronAPI.getLocalSecret();
  return fetch(`http://127.0.0.1:3001/v1/autonomy${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

export const useAutonomyStore = create<AutonomyStore>((set) => ({
  status: null,
  standupEntries: [],
  escalations: [],
  filters: { agents: [], eventTypes: [], since: 'today' },
  loading: false,

  fetchStatus: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    try {
      const res = await autonomyRequest('/status');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      set({ status: data.data || data });
    } catch (err) {
      console.error('[Autonomy] Failed to fetch status:', err);
    }
  },

  fetchStandup: async (agent?: string, type?: string) => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loading: true });
    try {
      const params = new URLSearchParams();
      if (agent) params.set('agent', agent);
      if (type) params.set('type', type);
      const qs = params.toString();
      const res = await autonomyRequest(`/standup${qs ? '?' + qs : ''}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const entries: StandupEntry[] = Array.isArray(data.data) ? data.data : (data.data?.entries || data.entries || []);
      const escalations = entries.filter(e =>
        e.event_type === 'blocked' || e.event_type === 'review_failed'
      );
      set({ standupEntries: entries, escalations, loading: false });
    } catch (err) {
      console.error('[Autonomy] Failed to fetch standup:', err);
      set({ loading: false, error: 'Failed to fetch standup' });
    }
  },

  startAutonomy: async (config) => {
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      const res = await autonomyRequest('/start', { method: 'POST', body: config });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      set({ status: data.data || data });
      return true;
    } catch (err) {
      console.error('[Autonomy] Failed to start:', err);
      return false;
    }
  },

  stopAutonomy: async () => {
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      const res = await autonomyRequest('/stop', { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      set({ status: data.data || data });
      return true;
    } catch (err) {
      console.error('[Autonomy] Failed to stop:', err);
      return false;
    }
  },

  updateFromSse: (data) => {
    // SSE autonomy-update event
    if (data.status) {
      set({ status: data.status as AutonomyStatus });
    }
    if (data.standupEntry) {
      const entry = data.standupEntry as StandupEntry;
      set((state) => ({
        standupEntries: [entry, ...state.standupEntries],
        escalations: (entry.event_type === 'blocked' || entry.event_type === 'review_failed')
          ? [entry, ...state.escalations]
          : state.escalations,
      }));
    }
  },

  setFilters: (filters) => set((state) => ({
    filters: { ...state.filters, ...filters },
  })),
}));
