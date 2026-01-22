import { create } from 'zustand';
import { StandupEntry, StandupFilters } from '@shared/types';

interface StandupStore {
  // State
  entries: StandupEntry[];
  filters: StandupFilters;
  loading: boolean;
  error: string | null;
  lastReviewedAt: Date | null;
  unreadCount: number;

  // Actions
  setEntries: (entries: StandupEntry[]) => void;
  addEntries: (entries: StandupEntry[]) => void;
  setFilters: (filters: Partial<StandupFilters>) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  markAsReviewed: () => void;
  clearEntries: () => void;
}

// Mock data for development
const MOCK_ENTRIES: StandupEntry[] = [
  {
    id: 1,
    agent: 'DotNetPert',
    event_type: 'completed',
    summary: 'Implemented agent_documents schema migration',
    task_id: 42,
    created_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  },
  {
    id: 2,
    agent: 'NextPert',
    event_type: 'started',
    summary: 'Starting Mail Push SSE implementation',
    task_id: 43,
    created_at: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
  },
  {
    id: 3,
    agent: 'NextPert',
    event_type: 'completed',
    summary: 'Mail Push SSE implementation complete',
    task_id: 43,
    created_at: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
  },
  {
    id: 4,
    agent: 'QAPert',
    event_type: 'review_passed',
    summary: 'Approved Mail Push SSE Implementation',
    task_id: 43,
    created_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  },
  {
    id: 5,
    agent: 'BAPert',
    event_type: 'milestone_done',
    summary: 'Phase 1 Mail System complete',
    created_at: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
  },
];

const DEFAULT_FILTERS: StandupFilters = {
  agents: [],
  eventTypes: [],
  since: 'today',
};

export const useStandupStore = create<StandupStore>((set, get) => ({
  // Initial state with mock data
  entries: MOCK_ENTRIES,
  filters: DEFAULT_FILTERS,
  loading: false,
  error: null,
  lastReviewedAt: null,
  unreadCount: MOCK_ENTRIES.length,

  // Actions
  setEntries: (entries) => {
    const lastReviewed = get().lastReviewedAt;
    const unreadCount = lastReviewed
      ? entries.filter((e) => new Date(e.created_at) > lastReviewed).length
      : entries.length;
    set({ entries, unreadCount });
  },

  addEntries: (newEntries) => {
    const existing = get().entries;
    const existingIds = new Set(existing.map((e) => e.id));
    const uniqueNew = newEntries.filter((e) => !existingIds.has(e.id));
    if (uniqueNew.length > 0) {
      const lastReviewed = get().lastReviewedAt;
      const newUnread = lastReviewed
        ? uniqueNew.filter((e) => new Date(e.created_at) > lastReviewed).length
        : uniqueNew.length;
      set({
        entries: [...uniqueNew, ...existing],
        unreadCount: get().unreadCount + newUnread,
      });
    }
  },

  setFilters: (partialFilters) => {
    set((state) => ({
      filters: { ...state.filters, ...partialFilters },
    }));
  },

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  markAsReviewed: () => {
    set({
      lastReviewedAt: new Date(),
      unreadCount: 0,
    });
    // TODO: Optionally POST to backend for audit trail
  },

  clearEntries: () => set({ entries: [], unreadCount: 0 }),
}));

// Selector: get filtered entries
export function useFilteredEntries() {
  const { entries, filters } = useStandupStore();

  return entries.filter((entry) => {
    // Agent filter
    if (filters.agents.length > 0 && !filters.agents.includes(entry.agent)) {
      return false;
    }

    // Event type filter
    if (filters.eventTypes.length > 0 && !filters.eventTypes.includes(entry.event_type)) {
      return false;
    }

    // Time filter
    const entryDate = new Date(entry.created_at);
    const now = new Date();
    switch (filters.since) {
      case 'today': {
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (entryDate < startOfDay) return false;
        break;
      }
      case '24h': {
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        if (entryDate < yesterday) return false;
        break;
      }
      case '7d': {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (entryDate < weekAgo) return false;
        break;
      }
      case 'custom': {
        if (filters.customSince && entryDate < new Date(filters.customSince)) {
          return false;
        }
        break;
      }
    }

    return true;
  });
}
