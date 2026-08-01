import { useCallback, useEffect, useId, useState } from 'react';
import { Users, AlertTriangle } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useTeamStore } from '../../stores/teamStore';
import {
  engageProjectTeam,
  fetchStandingTeams,
  teamDisplayName,
  type EngageConflictInfo,
  type StandingTeam,
} from '../../stores/api-helpers';
import { applyCloudRosterToAgents } from '../../lib/applyCloudRoster';

// "No team engaged — pick a team" CTA (WO-ACP-LIVE-TEAM-MERGE ACP-2).
//
// Under the live-team model a fresh project has NO standing team engaged;
// its roster read is legitimately empty (200, not an error). Instead of a
// bare empty grid the user gets this explicit engage affordance (locked
// decision: explicit engage, no auto-engage magic). Lists standing teams via
// the sidecar GET /v1/teams proxy and engages via POST /v1/projects/:id/teams
// — the single assignment path. A 409 ENGAGE_CONFIRM_REQUIRED (project
// already has a team) renders the swap-consent panel with the cloud's
// verbatim current_team / incoming_team / lost_overrides; confirming re-POSTs
// with ?confirm=true.

export function EngageTeamCTA() {
  const activeProject = useProjectStore((s) => s.activeProject);
  const [teams, setTeams] = useState<StandingTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [loading, setLoading] = useState(false);
  const [engaging, setEngaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<EngageConflictInfo | null>(null);
  // Post-engage refresh failure: the engage COMMITTED server-side but the
  // local roster/DTO refresh threw. Recoverable — retry the refresh, never
  // re-engage.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const selectId = useId();

  const loadTeams = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchStandingTeams();
      setTeams(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load teams');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Project switch: drop ALL per-project engage state so a stale swap
    // panel can never re-POST confirm=true against the newly-selected
    // project.
    setConflict(null);
    setError(null);
    setSelectedTeamId('');
    setRefreshError(null);
    void loadTeams();
  }, [loadTeams, activeProject?.id]);

  if (!activeProject) return null;

  const finishEngage = async (projectId: number) => {
    const store = useProjectStore.getState();
    try {
      // Refresh the DTO (engaged_team_id is now set — this also auto-clears
      // the noTeamEngaged slice) and the roster through the existing paths,
      // then apply the cloud roster to the grid (Phase 5 is keyed on project
      // id and does not refire on a roster-only change).
      await store.fetchActiveProject({ force: true });
      await store.fetchCurrentProjectTeam(projectId, { force: true });
      await useTeamStore.getState().syncTeam(projectId, { force: true });
      applyCloudRosterToAgents();
      store.clearNoTeamEngaged();
      // Re-run the spawn fan-out: the no-team abort left the RUNNING
      // transition unconsumed, so this reseed re-fires the orchestrator.
      await window.electronAPI.reseedLifecycle(projectId);
      setRefreshError(null);
    } catch (e) {
      // Engage already committed server-side; only the local convergence
      // failed. Surface a recoverable state (retry refresh) instead of an
      // unhandled rejection + a CTA stuck looking un-engaged.
      console.error('[EngageTeamCTA] post-engage refresh failed:', e);
      setRefreshError(e instanceof Error ? e.message : 'Refresh failed');
    }
  };

  const engage = async (confirm: boolean) => {
    if (!selectedTeamId) return;
    setEngaging(true);
    setError(null);
    try {
      const result = await engageProjectTeam(activeProject.id, selectedTeamId, { confirm });
      if (result.ok) {
        setConflict(null);
        await finishEngage(activeProject.id);
      } else if ('conflict' in result) {
        setConflict(result.conflict);
      } else {
        setError(result.error);
      }
    } finally {
      setEngaging(false);
    }
  };

  const lostOverrides = Array.isArray(conflict?.lost_overrides) ? conflict.lost_overrides.length : 0;

  return (
    <div className="h-full flex items-center justify-center bg-acp-bg">
      <div className="w-[26rem] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <span className="text-sm font-semibold text-slate-100">
              No team engaged
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-3">
          {refreshError ? (
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-slate-400 leading-relaxed">
                Team engaged on <span className="text-slate-300 font-medium">{activeProject.name}</span>,
                but refreshing the roster failed: <span className="text-red-400">{refreshError}</span>.
                Retry the refresh — no need to re-engage.
              </p>
            </div>
          ) : conflict ? (
            <>
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-slate-400 leading-relaxed">
                  <span className="text-slate-300 font-medium">{activeProject.name}</span> already has{' '}
                  <span className="text-slate-200">{teamDisplayName(conflict.current_team)}</span> engaged.
                  Swap to <span className="text-slate-200">{teamDisplayName(conflict.incoming_team)}</span>?
                  {lostOverrides > 0 && (
                    <>
                      {' '}
                      <span className="text-amber-300">
                        {lostOverrides} per-agent override{lostOverrides === 1 ? '' : 's'} on the current
                        team will be lost.
                      </span>
                    </>
                  )}
                </p>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-400 leading-relaxed">
                <span className="text-slate-300 font-medium">{activeProject.name}</span> has no standing
                team engaged, so its roster is empty and no agents can start. Pick a team to engage.
              </p>
              <div>
                <label htmlFor={selectId} className="sr-only">
                  Standing team
                </label>
                <select
                  id={selectId}
                  value={selectedTeamId}
                  onChange={(e) => setSelectedTeamId(e.target.value)}
                  disabled={loading || engaging || teams.length === 0}
                  className="w-full px-2 py-1.5 text-xs bg-slate-950 border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-emerald-500/50 disabled:opacity-50"
                >
                  <option value="">
                    {loading ? 'Loading teams…' : teams.length === 0 ? 'No standing teams found' : 'Select a team…'}
                  </option>
                  {teams.map((t) => (
                    <option key={String(t.id)} value={String(t.id)}>
                      {t.name}
                      {typeof t.member_count === 'number' ? ` (${t.member_count})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {error && <div className="text-xs text-red-400">{error}</div>}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-700 px-3 py-2.5 flex items-center justify-end gap-2">
          {refreshError ? (
            <button
              type="button"
              onClick={() => void finishEngage(activeProject.id)}
              className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
            >
              Retry refresh
            </button>
          ) : conflict ? (
            <>
              <button
                type="button"
                onClick={() => setConflict(null)}
                disabled={engaging}
                className="text-xs text-slate-400 hover:text-slate-200 px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void engage(true)}
                disabled={engaging}
                className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition-colors disabled:opacity-50"
              >
                {engaging ? '…' : 'Swap team'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void loadTeams()}
                disabled={loading || engaging}
                className="text-xs text-slate-400 hover:text-slate-200 px-3 py-1.5"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={() => void engage(false)}
                disabled={engaging || !selectedTeamId}
                className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors disabled:opacity-50"
              >
                {engaging ? '…' : 'Engage team'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
