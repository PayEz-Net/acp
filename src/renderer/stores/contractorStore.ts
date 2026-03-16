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
  status: 'active' | 'completed' | 'cancelled' | 'expired';
  profile_source?: string;
  profile_snapshot?: ContractorProfile;
  timeout_hours: number;
  created_at: string;
  completed_at?: string;
}

export interface ActiveContractor {
  agent: ContractorAgent;
  contract: AgentContract;
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

  // SSE handlers
  handleContractorHired: (data: Record<string, unknown>) => void;
  handleContractorCompleted: (data: Record<string, unknown>) => void;
  handleContractorExpired: (data: Record<string, unknown>) => void;
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
      const res = await contractorRequest('/active');
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

  // SSE: new contractor hired — refresh list
  handleContractorHired: (_data) => {
    get().fetchActive();
  },

  // SSE: contract completed — refresh list
  handleContractorCompleted: (_data) => {
    get().fetchActive();
  },

  // SSE: contract expired — refresh list
  handleContractorExpired: (_data) => {
    get().fetchActive();
  },
}));
