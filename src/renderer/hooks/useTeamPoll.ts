/**
 * Background poll — keeps the SESSION's pinned project's TEAM converged across
 * surfaces (web GSD / CLI → desktop within 60s, no manual refresh).
 *
 * Startup-project is LAUNCH-ONCE (P0, BAPert 1065): this poll must NEVER
 * re-read or switch the active project. It used to call fetchActiveProject({force})
 * and auto-switch on a remote diff (reloadProjectScopedStores) — which
 * live-reloaded the running session when the startup project was changed on
 * another device. That path is severed. The session stays pinned to its
 * launch-time project until shutdown; only that project's team membership is
 * refreshed here (a legit cross-surface convergence — team adds/removes, never
 * a project switch).
 *
 * Spec ref: `acp-dynamic-team-loading-v1-spec.md` §4.6 / Decision 7.
 *
 * Mounts once at App.tsx top level when `isAuthenticated && activeProject`.
 * Single-flight is guaranteed by the setTimeout chain (next tick scheduled
 * only after previous resolves). Pause-on-blur saves battery on laptops.
 */
import { useEffect } from 'react';
import { AuthFlowState, useAuthStore } from '../stores/authStore';
import { useProjectStore } from '../stores/projectStore';
import { useTeamStore } from '../stores/teamStore';
import { applyCloudRosterToAgents } from '../lib/applyCloudRoster';

const POLL_MS = 60_000;

export function useTeamPoll(): void {
  const isAuthed = useAuthStore((s) => s.authFlowState === AuthFlowState.AUTHENTICATED);
  const activeProjectId = useProjectStore((s) => s.activeProject?.id);

  useEffect(() => {
    if (!isAuthed || !activeProjectId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        // Pinned to the session's launch-time project (P0, BAPert 1065): refresh
        // ONLY that project's team. Never fetchActiveProject / switch / reload
        // scoped stores — re-reading the startup-project row is exactly what bled
        // a remote device's switch into this running session. `force` bypasses the
        // 60s read-through cache so the poll stays the team-freshness path.
        const prevCount = useTeamStore.getState().cloudAgents.length;
        await useTeamStore.getState().syncTeam(activeProjectId, { force: true });

        // ACP-2 cross-surface converge (WO-ACP-LIVE-TEAM-MERGE review): a team
        // engaged from ANOTHER surface (web) while the desktop shows the engage
        // CTA flips this project's live roster empty → non-empty. Detect that
        // transition and converge the desktop the same way the CTA's own engage
        // does — clear the no-team surface, apply the roster to the grid, and
        // reseed the lifecycle so the orchestrator spawns. Gated on
        // pickerHasStarted: before the user's explicit Start, instantiation
        // must NOT fire (lifecycle-hub seed rule). Deliberately does NOT call
        // fetchActiveProject (the severed remote-switch path above) — the
        // non-empty roster itself wins the grid over the CTA, and the DTO's
        // engaged_team_id hydrates on the next boot-time fetch.
        const ps = useProjectStore.getState();
        const nowCount = useTeamStore.getState().cloudAgents.length;
        if (
          prevCount === 0 &&
          nowCount > 0 &&
          ps.pickerHasStarted &&
          ps.activeProject?.id === activeProjectId &&
          (ps.activeProject.engaged_team_id == null || ps.noTeamEngaged?.projectId === activeProjectId)
        ) {
          console.log(`[useTeamPoll] roster empty→${nowCount} for un-engaged project=${activeProjectId} — team engaged on another surface; converging`);
          ps.clearNoTeamEngaged();
          await ps.fetchCurrentProjectTeam(activeProjectId, { force: true });
          applyCloudRosterToAgents();
          await window.electronAPI.reseedLifecycle();
        }
      } catch (err) {
        // Soft-fail: warning surfaces via teamStore.syncError if relevant.
        console.warn('[useTeamPoll] tick failed', err);
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS);
      }
    };

    timer = setTimeout(tick, POLL_MS);

    const onVisibility = () => {
      if (document.hidden) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      } else if (!timer && !cancelled) {
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isAuthed, activeProjectId]);
}
