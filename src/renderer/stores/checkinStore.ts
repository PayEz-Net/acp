/**
 * Team Check-in (Standup W3) store.
 *
 * Holds the current round + history read from the DURABLE doc-store via
 * checkin/api. FAIL LOUD: read/call errors land in the *Error fields and are
 * surfaced by the UI — there is NO fallback to the in-memory activity ring
 * (D2 + Aurum sharpening #2). SSE handlers (W2 transport) patch live reports
 * into the current round as they land.
 */

import { create } from 'zustand';
import { fetchCurrentRound, fetchRoundHistory, openRound } from '../checkin/api';
import type { StandupRound, StandupReportEvent, StandupRoundEvent } from '../checkin/types';

interface CheckinStore {
  currentRound: StandupRound | null;
  history: StandupRound[];
  loading: boolean;
  error: string | null;
  historyLoading: boolean;
  historyError: string | null;
  calling: boolean;
  callError: string | null;

  loadCurrentRound: () => Promise<void>;
  loadHistory: () => Promise<void>;
  callStandup: () => Promise<void>;

  // SSE (W2): live report / round-status updates.
  handleReportSse: (evt: StandupReportEvent) => void;
  handleRoundSse: (evt: StandupRoundEvent) => void;
}

export const useCheckinStore = create<CheckinStore>((set, get) => ({
  currentRound: null,
  history: [],
  loading: false,
  error: null,
  historyLoading: false,
  historyError: null,
  calling: false,
  callError: null,

  loadCurrentRound: async () => {
    set({ loading: true, error: null });
    try {
      const round = await fetchCurrentRound();
      set({ currentRound: round, loading: false });
    } catch (err) {
      // FAIL LOUD — surface it; never silently drop back to the activity ring.
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load the check-in.' });
    }
  },

  loadHistory: async () => {
    set({ historyLoading: true, historyError: null });
    try {
      const rounds = await fetchRoundHistory();
      set({ history: rounds, historyLoading: false });
    } catch (err) {
      set({ historyLoading: false, historyError: err instanceof Error ? err.message : 'Failed to load check-in history.' });
    }
  },

  callStandup: async () => {
    set({ calling: true, callError: null });
    try {
      const round = await openRound();
      set({ currentRound: round, calling: false });
    } catch (err) {
      set({ calling: false, callError: err instanceof Error ? err.message : 'Failed to call standup.' });
    }
  },

  handleReportSse: (evt) => {
    const cur = get().currentRound;
    if (!cur || cur.round_id !== evt.round_id) return;
    const reports = cur.reports.slice();
    const idx = reports.findIndex((r) => r.agent_id === evt.report.agent_id);
    if (idx >= 0) reports[idx] = evt.report;
    else reports.push(evt.report);
    set({ currentRound: { ...cur, reports } });
  },

  handleRoundSse: (evt) => {
    const cur = get().currentRound;
    const isNewerOrSame =
      !cur ||
      evt.round.round_id === cur.round_id ||
      new Date(evt.round.started_at).getTime() >= new Date(cur.started_at).getTime();
    if (isNewerOrSame) set({ currentRound: evt.round });
  },
}));
