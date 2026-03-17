import { create } from 'zustand';
import { useAppStore } from './appStore';

// --- Types ---

export interface ContractorProfile {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
}

export interface ContractorAgent {
  id: number;
  name: string;
  agent_type: 'contractor';
  display_name?: string;
  role?: string;
  model?: string;
  expertise_json?: { tools?: string[] };
  is_active: boolean;
}

export interface AgentContract {
  id: number;
  contractor_agent_id: number;
  hired_by_agent_id: number;
  hired_by_name?: string;
  contractor_name?: string;
  contract_subject: string;
  status: 'active' | 'completed' | 'cancelled' | 'expired' | 'queued';
  profile_source?: string;
  profile_snapshot?: ContractorProfile;
  timeout_hours: number;
  cancel_reason?: string;
  session_pid?: number;
  session_started_at?: string;
  session_ended_at?: string;
  exit_code?: number;
  created_at: string;
  completed_at?: string;
}

export interface ActiveContractor {
  agent: ContractorAgent;
  contract: AgentContract;
}

export interface ContractOutput {
  lines: string[];
  truncated: boolean;
}

export interface ContractMailMessage {
  id: number;
  from_agent: string;
  to: string[];
  subject: string;
  body: string;
  created_at: string;
}

// --- API helper ---

async function contractorRequest(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
  const { method = 'GET', body } = options;
  const secret = await window.electronAPI.getLocalSecret();
  return fetch(`http://127.0.0.1:3001/v1/contractors${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function contractRequest(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
  const { method = 'GET', body } = options;
  const secret = await window.electronAPI.getLocalSecret();
  return fetch(`http://127.0.0.1:3001/v1/contracts${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// --- Debounced refresh for SSE handlers ---
// Multiple SSE events can fire in rapid succession (e.g., queued → session-started).
// Without debounce, each triggers a separate fetchActive() API call.
let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedRefresh(fetchActive: () => Promise<void>, delay = 300) {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => {
    _refreshTimer = null;
    fetchActive();
  }, delay);
}

// --- Store ---

interface ContractorStore {
  // State
  activeContractors: ActiveContractor[];
  pool: ContractorProfile[];
  selectedContractor: ActiveContractor | null;
  showHirePicker: boolean;
  loading: boolean;
  poolLoading: boolean;
  error?: string;

  // Actions
  setSelectedContractor: (c: ActiveContractor | null) => void;
  setShowHirePicker: (show: boolean) => void;

  // API
  fetchActive: () => Promise<void>;
  fetchPool: () => Promise<void>;
  completeContract: (contractId: number) => Promise<boolean>;
  cancelContract: (contractId: number, reason?: string) => Promise<boolean>;
  fetchContractMail: (agentName: string, contractId: number) => Promise<ContractMailMessage[]>;
  fetchContractOutput: (contractId: number) => Promise<ContractOutput>;

  // SSE handlers
  handleContractorHired: (data: Record<string, unknown>) => void;
  handleContractorCompleted: (data: Record<string, unknown>) => void;
  handleContractorExpired: (data: Record<string, unknown>) => void;
  handleContractorCancelled: (data: Record<string, unknown>) => void;
  handleContractorQueued: (data: Record<string, unknown>) => void;
  handleSessionStarted: (data: Record<string, unknown>) => void;
  handleSessionOutput: (data: Record<string, unknown>) => void;
  handleSessionExited: (data: Record<string, unknown>) => void;
}

export const useContractorStore = create<ContractorStore>((set, get) => ({
  activeContractors: [],
  pool: [],
  selectedContractor: null,
  showHirePicker: false,
  loading: false,
  poolLoading: false,

  setSelectedContractor: (c) => set({ selectedContractor: c }),
  setShowHirePicker: (show) => set({ showHirePicker: show }),

  fetchActive: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loading: true, error: undefined });
    try {
      const res = await contractorRequest('/active?status=all');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const activeContractors: ActiveContractor[] = data.data?.contractors || data.data || [];
      set({ activeContractors, loading: false });
    } catch (err) {
      console.error('[Contractors] Failed to fetch active:', err);
      set({ loading: false, error: 'Failed to fetch contractors' });
    }
  },

  fetchPool: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ poolLoading: true });
    try {
      const res = await contractorRequest('/pool');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const pool: ContractorProfile[] = data.data?.profiles || data.data || [];
      set({ pool, poolLoading: false });
    } catch (err) {
      console.error('[Contractors] Failed to fetch pool:', err);
      set({ poolLoading: false });
    }
  },

  completeContract: async (contractId) => {
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      const res = await contractRequest(`/${contractId}/complete`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status}`);
      await get().fetchActive();
      return true;
    } catch (err) {
      console.error('[Contractors] Failed to complete contract:', err);
      return false;
    }
  },

  cancelContract: async (contractId, reason) => {
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      const res = await contractRequest(`/${contractId}/cancel`, {
        method: 'POST',
        body: reason ? { reason } : undefined,
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await get().fetchActive();
      return true;
    } catch (err) {
      console.error('[Contractors] Failed to cancel contract:', err);
      return false;
    }
  },

  fetchContractMail: async (agentName, contractId) => {
    if (!useAppStore.getState().backendAvailable) return [];
    try {
      const res = await contractorRequest(`/${encodeURIComponent(agentName)}/mail?contract_id=${contractId}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      return (data.data?.messages || data.data || []) as ContractMailMessage[];
    } catch (err) {
      console.error('[Contractors] Failed to fetch contract mail:', err);
      return [];
    }
  },

  fetchContractOutput: async (contractId) => {
    if (!useAppStore.getState().backendAvailable) return { lines: [], truncated: false };
    try {
      const res = await contractRequest(`/${contractId}/output`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      return (data.data || { lines: [], truncated: false }) as ContractOutput;
    } catch (err) {
      console.error('[Contractors] Failed to fetch contract output:', err);
      return { lines: [], truncated: false };
    }
  },

  // SSE: new contractor hired — debounced refresh
  handleContractorHired: (_data) => {
    debouncedRefresh(get().fetchActive);
  },

  // SSE: contract completed — debounced refresh
  handleContractorCompleted: (_data) => {
    debouncedRefresh(get().fetchActive);
  },

  // SSE: contract expired — debounced refresh
  handleContractorExpired: (_data) => {
    debouncedRefresh(get().fetchActive);
  },

  // SSE: contract cancelled — debounced refresh
  handleContractorCancelled: (_data) => {
    debouncedRefresh(get().fetchActive);
  },

  // SSE: contract queued (at capacity) — debounced refresh
  handleContractorQueued: (_data) => {
    debouncedRefresh(get().fetchActive);
  },

  // SSE: session spawned — debounced refresh
  handleSessionStarted: (_data) => {
    debouncedRefresh(get().fetchActive);
  },

  // SSE: session output line — no refresh, handled by component
  handleSessionOutput: (_data) => {
    // Handled directly by SessionOutputLog component via event bus
  },

  // SSE: session exited — debounced refresh
  handleSessionExited: (_data) => {
    debouncedRefresh(get().fetchActive);
  },
}));
