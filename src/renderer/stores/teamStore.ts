/**
 * Team store — owns the cloud-vs-local roster merge for the desktop.
 *
 * Spec ref: `acp-dynamic-team-loading-v1-spec.md` §4.1.
 *
 * Pulled out of `appStore` so `appStore` keeps its tight scope (UI flags,
 * settings, agents *array*). This store fetches the cloud roster via the
 * acp-stable-api `/v1/team/sync` proxy and exposes it as `cloudAgents`.
 * The reconcile + `setAgents` happens in App.tsx Phase 5 (§4.3).
 *
 * Auth path: renderer → acp-stable-api → idealvibe (Decision 2). Bearer
 * is the LOCAL secret minted by the desktop, NOT the IDP token. The
 * stable-api side handles the IDP refresh dance.
 */
import { create } from 'zustand';
import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import type { NormalizedAgent } from '../lib/agentReconcile';

export type TeamSource = 'cloud' | 'cache' | 'defaults' | null;

interface TeamStore {
  cloudAgents: NormalizedAgent[];
  source: TeamSource;
  fetchedAt: string | null;
  warning: string | null;
  syncing: boolean;
  syncError: string | null;

  syncTeam: (projectId: number, opts?: { force?: boolean }) => Promise<void>;
  clearTeam: () => void;
}

export const useTeamStore = create<TeamStore>((set, get) => ({
  cloudAgents: [],
  source: null,
  fetchedAt: null,
  warning: null,
  syncing: false,
  syncError: null,

  syncTeam: async (projectId, opts = {}) => {
    const { force = false } = opts;
    set({ syncing: true, syncError: null });
    try {
      const secret = await window.electronAPI.getLocalSecret();
      const url = `http://127.0.0.1:3001/v1/team/sync?project_id=${encodeURIComponent(
        String(projectId),
      )}&force_refresh=${force ? 'true' : 'false'}`;
      const res = await fetch(url, {
        headers: {
          [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
      });

      if (res.status === 401) {
        // A 401 here means the API's IDP token is momentarily invalid —
        // token refresh is the API's job (separation of presentation vs
        // communication). Do NOT logout(): that wiped the API's session
        // too (electronAPI.authLogout) and forced a full re-OAuth on a
        // transient blip while the API was about to single-flight-refresh
        // and recover. Soft-flag only; the next poll succeeds once the
        // API has refreshed. Genuine dead sessions still route to login
        // via the legitimate auth path, not this poller.
        set({ syncing: false, syncError: 'unauthenticated' });
        return;
      }

      if (!res.ok) {
        // 5xx / 4xx other than 401 — preserve last cloudAgents, mark error.
        // Banner UX (§4.5) renders on `syncError` truthiness or `source !== 'cloud'`.
        const text = await res.text().catch(() => '');
        set({
          syncing: false,
          syncError: text || `Team sync failed: ${res.status}`,
        });
        return;
      }

      const body = await res.json();
      const data = body?.data ?? body ?? {};
      const agents: NormalizedAgent[] = Array.isArray(data.agents) ? data.agents : [];
      const source: TeamSource =
        data.source === 'cloud' || data.source === 'cache' || data.source === 'defaults'
          ? data.source
          : 'cloud';
      const fetchedAt: string =
        typeof data.fetchedAt === 'string' ? data.fetchedAt : new Date().toISOString();
      const warning: string | null =
        typeof data.warning === 'string' && data.warning.length > 0 ? data.warning : null;

      set({
        cloudAgents: agents,
        source,
        fetchedAt,
        warning,
        syncing: false,
        syncError: null,
      });
    } catch (err) {
      // Network failure — preserve last cloudAgents, set syncError so the
      // banner renders. Don't clobber `source` so the banner can still
      // distinguish cache-from-prior-sync vs never-synced.
      console.error('[TeamStore] syncTeam failed:', err);
      set({
        syncing: false,
        syncError: err instanceof Error ? err.message : 'Network error',
      });
      // First-ever sync with no prior cloudAgents — fall back to defaults
      // surface so the banner reads "Working offline" rather than implying
      // we have a cached roster.
      if (get().cloudAgents.length === 0) {
        set({ source: 'defaults' });
      }
    }
  },

  clearTeam: () =>
    set({
      cloudAgents: [],
      source: null,
      fetchedAt: null,
      warning: null,
      syncing: false,
      syncError: null,
    }),
}));
