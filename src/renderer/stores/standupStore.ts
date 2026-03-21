import { create } from 'zustand';
import { StandupEntry, StandupFilters } from '@shared/types';
import { useAppStore } from './appStore';

// --- Meeting Note Types ---

export interface StandupMeetingNote {
  id: string;
  date: string;
  trigger: 'scheduled' | 'adhoc';
  attendees: string[];
  absent: string[];
  entries: StandupEntry[];
  summary: string;
}

export interface StandupSchedule {
  time: string; // HH:mm
  enabled: boolean;
}

// --- Store ---

interface StandupStore {
  // Entries from API
  entries: StandupEntry[];
  filters: StandupFilters;
  loading: boolean;
  error: string | null;

  // Badge
  lastReviewedAt: Date | null;
  unreadCount: number;

  // Schedule
  schedule: StandupSchedule;

  // Meeting notes history
  meetingNotes: StandupMeetingNote[];

  // Running standup state
  standupInProgress: boolean;
  standupAgentsMailed: string[];

  // Actions
  fetchEntries: () => Promise<void>;
  setEntries: (entries: StandupEntry[]) => void;
  addEntries: (entries: StandupEntry[]) => void;
  setFilters: (filters: Partial<StandupFilters>) => void;
  markAsReviewed: () => void;
  clearEntries: () => void;

  // Standup actions
  triggerStandup: () => Promise<void>;
  setSchedule: (schedule: StandupSchedule) => void;
  saveMeetingNote: (note: StandupMeetingNote) => void;
  loadMeetingNotes: () => void;
}

const DEFAULT_FILTERS: StandupFilters = {
  agents: [],
  eventTypes: [],
  since: 'today',
};

// Persist schedule and meeting notes to localStorage
function loadSchedule(): StandupSchedule {
  try {
    const saved = localStorage.getItem('acp:standup:schedule');
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return { time: '09:00', enabled: false };
}

function loadMeetingNotes(): StandupMeetingNote[] {
  try {
    const saved = localStorage.getItem('acp:standup:meetingNotes');
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return [];
}

// Helper to make authenticated requests to acp-api
async function standupRequest(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
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

// Agent mail API for standup notifications
const MAIL_API = 'https://api.idealvibe.online/v1/agentmail';
const MAIL_HEADERS = {
  'X-Vibe-Client-Id': 'vibe_b2d2aac0315549d9',
  'X-Vibe-Client-Secret': 'VOmsyIqL4NHGq1V1c4HUhjPLYqpFeNfx',
  'X-Vibe-User-Id': '0',
  'Content-Type': 'application/json',
};

export const useStandupStore = create<StandupStore>((set, get) => ({
  entries: [],
  filters: DEFAULT_FILTERS,
  loading: false,
  error: null,
  lastReviewedAt: null,
  unreadCount: 0,
  schedule: loadSchedule(),
  meetingNotes: loadMeetingNotes(),
  standupInProgress: false,
  standupAgentsMailed: [],

  fetchEntries: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    const prev = get();
    if (prev.loading) return; // guard against duplicate fetches
    set({ loading: true, error: null });
    try {
      const res = await standupRequest('/standup');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const entries: StandupEntry[] = Array.isArray(data.data) ? data.data : (data.data?.entries || data.entries || []);

      const lastReviewed = get().lastReviewedAt;
      const unreadCount = lastReviewed
        ? entries.filter((e) => new Date(e.created_at) > lastReviewed).length
        : entries.length;

      set({ entries, unreadCount, loading: false });
    } catch (err) {
      console.error('[Standup] Failed to fetch entries:', err);
      set({ loading: false, error: 'Failed to fetch standup entries' });
    }
  },

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

  markAsReviewed: () => {
    set({ lastReviewedAt: new Date(), unreadCount: 0 });
  },

  clearEntries: () => set({ entries: [], unreadCount: 0 }),

  triggerStandup: async () => {
    const agents = useAppStore.getState().agents;
    const agentNames = agents.map(a => a.name);
    set({ standupInProgress: true, standupAgentsMailed: [] });

    try {
      // Send mail to all agents
      const res = await fetch(`${MAIL_API}/send`, {
        method: 'POST',
        headers: MAIL_HEADERS,
        body: JSON.stringify({
          from_agent: 'ACP-System',
          to: agentNames,
          subject: 'STANDUP: Report your status',
          body: `Standup called at ${new Date().toLocaleTimeString()}.\n\nPlease reply with:\n1. What you completed since last standup\n2. What you are working on now\n3. Any blockers\n\nReply to this mail with your update.`,
          importance: 'high',
        }),
      });

      if (res.ok) {
        set({ standupAgentsMailed: agentNames });
        console.log('[Standup] Notifications sent to:', agentNames);
      } else {
        console.error('[Standup] Failed to send notifications:', await res.text());
      }
    } catch (err) {
      console.error('[Standup] Failed to trigger standup:', err);
    }

    // Also try to trigger via backend API
    try {
      await standupRequest('/standup/trigger', { method: 'POST' });
    } catch {
      // Backend may not support this yet
    }

    set({ standupInProgress: false });
  },

  setSchedule: (schedule) => {
    set({ schedule });
    localStorage.setItem('acp:standup:schedule', JSON.stringify(schedule));
  },

  saveMeetingNote: (note) => {
    const notes = [note, ...get().meetingNotes].slice(0, 50); // keep last 50
    set({ meetingNotes: notes });
    localStorage.setItem('acp:standup:meetingNotes', JSON.stringify(notes));
  },

  loadMeetingNotes: () => {
    set({ meetingNotes: loadMeetingNotes() });
  },
}));

// Selector: get filtered entries
export function useFilteredEntries() {
  const { entries, filters } = useStandupStore();

  return entries.filter((entry) => {
    if (filters.agents.length > 0 && !filters.agents.includes(entry.agent)) {
      return false;
    }
    if (filters.eventTypes.length > 0 && !filters.eventTypes.includes(entry.event_type)) {
      return false;
    }
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
