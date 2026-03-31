import { create } from 'zustand';
import { AutonomyStatus, StandupEntry, StandupFilters } from '@shared/types';
import { useAppStore } from './appStore';

// --- Unattended Mode Types ---

export interface UnattendedConfig {
  leadAgent: string;
  pingIntervalMinutes: number;
  maxRuntimeHours: number;
}

export interface UnattendedState {
  active: boolean;
  paused: boolean;
  pauseReason?: string;
  config: UnattendedConfig | null;
  startedAt?: string;
  elapsedMinutes?: number;
  lastPingAt?: string;
}

// --- Store Interface ---

interface AutonomyStore {
  // State
  status: AutonomyStatus | null;
  standupEntries: StandupEntry[];
  escalations: StandupEntry[];
  filters: StandupFilters;
  loading: boolean;
  error?: string;

  // Unattended mode
  unattended: UnattendedState;

  // Actions
  fetchStatus: () => Promise<void>;
  fetchStandup: (agent?: string, type?: string) => Promise<void>;
  startAutonomy: (config: { specId?: number; maxRuntimeHours?: number; stopCondition?: string }) => Promise<boolean>;
  stopAutonomy: () => Promise<boolean>;
  startUnattended: (config: UnattendedConfig) => Promise<boolean>;
  stopUnattended: (reason?: string) => Promise<boolean>;
  emergencyStop: () => Promise<boolean>;
  dismissPaused: () => void;
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

const DEFAULT_UNATTENDED: UnattendedState = {
  active: false,
  paused: false,
  config: null,
};

export const useAutonomyStore = create<AutonomyStore>((set, get) => ({
  status: null,
  standupEntries: [],
  escalations: [],
  filters: { agents: [], eventTypes: [], since: 'today' },
  loading: false,
  unattended: DEFAULT_UNATTENDED,

  fetchStatus: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    try {
      const res = await autonomyRequest('/unattended/status');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const state = data.data || data;
      if (state.unattendedMode !== undefined) {
        set({
          status: state,
          unattended: {
            active: state.unattendedMode,
            paused: state.paused || false,
            pauseReason: state.pauseReason,
            config: state.config || get().unattended.config,
            startedAt: state.startedAt,
            elapsedMinutes: state.elapsedMinutes,
            lastPingAt: state.lastPingAt,
          },
        });
      } else {
        set({ status: state });
      }
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

  startUnattended: async (config) => {
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      const res = await autonomyRequest('/unattended/start', {
        method: 'POST',
        body: config,
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      set({
        status: data.data || data,
        unattended: {
          active: true,
          paused: false,
          config,
          startedAt: new Date().toISOString(),
        },
      });
      useAppStore.getState().setAutonomyEnabled(true);
      return true;
    } catch (err) {
      console.error('[Autonomy] Failed to start unattended:', err);
      return false;
    }
  },

  stopUnattended: async (reason) => {
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      const res = await autonomyRequest('/unattended/stop', {
        method: 'POST',
        body: { reason: reason || 'manual' },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const prev = get().unattended;
      set({
        status: data.data || data,
        unattended: {
          ...prev,
          active: false,
          paused: reason !== 'manual',
          pauseReason: reason || 'manual',
        },
      });
      useAppStore.getState().setAutonomyEnabled(false);
      return true;
    } catch (err) {
      console.error('[Autonomy] Failed to stop unattended:', err);
      return false;
    }
  },

  emergencyStop: async () => {
    // Hard stop — immediate kill, bypasses soft shutdown SLA
    try {
      const res = await autonomyRequest('/unattended/emergency-stop', { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status}`);
    } catch (err) {
      console.error('[Autonomy] Emergency stop API call failed:', err);
    }
    // Always clear local state regardless of API result
    set({ unattended: { ...DEFAULT_UNATTENDED, paused: true, pauseReason: 'emergency' } });
    useAppStore.getState().setAutonomyEnabled(false);
    return true;
  },

  dismissPaused: () => {
    set({ unattended: DEFAULT_UNATTENDED });
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
    // Unattended mode SSE events
    if (data.mode === 'unattended' || data.unattendedMode !== undefined) {
      const prev = get().unattended;
      set({
        unattended: {
          ...prev,
          active: (data.unattendedMode as boolean) ?? prev.active,
          paused: (data.paused as boolean) ?? prev.paused,
          pauseReason: (data.pauseReason as string) ?? prev.pauseReason,
          elapsedMinutes: (data.elapsedMinutes as number) ?? prev.elapsedMinutes,
          lastPingAt: (data.lastPingAt as string) ?? prev.lastPingAt,
        },
      });
      if (data.unattendedMode === true) {
        useAppStore.getState().setAutonomyEnabled(true);
      } else if (data.unattendedMode === false) {
        useAppStore.getState().setAutonomyEnabled(false);
      }
    }
  },

  setFilters: (filters) => set((state) => ({
    filters: { ...state.filters, ...filters },
  })),
}));
