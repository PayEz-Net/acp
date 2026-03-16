import { create } from 'zustand';
import { AgentSignal, RelevanceScore, MingleSession, ACPZone } from '@shared/types';
import { useAppStore } from './appStore';

interface PartyStore {
  // State
  signals: Record<string, AgentSignal>;
  relevanceMatrix: RelevanceScore[];
  activeMingles: MingleSession[];
  isPaused: boolean;
  lastUpdated: number;
  loading: boolean;
  error?: string;

  // Actions
  fetchPartyState: () => Promise<void>;
  fetchRelevance: () => Promise<void>;
  updateFromSse: (data: Record<string, unknown>) => void;
}

async function partyRequest(endpoint: string): Promise<Response> {
  const secret = await window.electronAPI.getLocalSecret();
  return fetch(`http://127.0.0.1:3001/v1/party${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
    },
  });
}

export const usePartyStore = create<PartyStore>((set, get) => ({
  signals: {},
  relevanceMatrix: [],
  activeMingles: [],
  isPaused: false,
  lastUpdated: 0,
  loading: false,

  fetchPartyState: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loading: true });
    try {
      const res = await partyRequest('/state');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const state = data.data || data;
      set({
        signals: state.signals || {},
        activeMingles: state.activeMingles || [],
        isPaused: state.isPaused ?? false,
        lastUpdated: Date.now(),
        loading: false,
      });
    } catch (err) {
      console.error('[Party] Failed to fetch state:', err);
      set({ loading: false, error: 'Failed to fetch party state' });
    }
  },

  fetchRelevance: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    try {
      const res = await partyRequest('/relevance');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      set({ relevanceMatrix: data.data || data.relevance || [] });
    } catch (err) {
      console.error('[Party] Failed to fetch relevance:', err);
    }
  },

  updateFromSse: (data) => {
    // SSE party-update event — refresh state
    set({
      signals: (data.signals as Record<string, AgentSignal>) || get().signals,
      activeMingles: (data.activeMingles as MingleSession[]) || get().activeMingles,
      isPaused: (data.isPaused as boolean) ?? get().isPaused,
      lastUpdated: Date.now(),
    });
  },
}));
