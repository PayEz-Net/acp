/**
 * Team sync status banner — surfaces cloud-unreachable / cache-fallback
 * state above the terminal grid.
 *
 * Spec ref: `acp-dynamic-team-loading-v1-spec.md` §4.5.
 *
 *   source           warning   banner copy                                            color
 *   ----------       --------- ------------------------------------------------------ -------
 *   'cloud'          —         (none)                                                 —
 *   'cache'          null      (none — fresh TTL hit, happy cache, not a failure)     —
 *   'cache'          set       "Showing last-known team — couldn't reach idealvibe."  yellow
 *   'defaults'       —         "Working offline with default team — connect to        orange
 *                                idealvibe to load yours."
 *   null             —         (none — first sync in flight is a loading state)      —
 *
 * The warning field is set by acp-api only when the upstream cloud call
 * actually failed and we served stale cache as fallback. A bare
 * `source: 'cache'` with no warning means the 60s TTL kept us from
 * needing to hit cloud — that's normal operation, not a problem to
 * alarm the user about.
 *
 * Retry calls `syncTeam(activeProjectId, { force: true })`.
 */
import { RefreshCw } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useTeamStore } from '../../stores/teamStore';

export function TeamSyncBanner(): JSX.Element | null {
  const source = useTeamStore((s) => s.source);
  const warning = useTeamStore((s) => s.warning);
  const syncing = useTeamStore((s) => s.syncing);
  const syncTeam = useTeamStore((s) => s.syncTeam);
  const activeProjectId = useProjectStore((s) => s.activeProject?.id);

  // Hide on: cloud-fresh, no-source-yet, OR cache-hit-without-failure.
  // Show on: defaults (no team) OR cache-with-warning (actually failed).
  if (source === null || source === 'cloud') return null;
  if (source === 'cache' && !warning) return null;

  const onRetry = () => {
    if (activeProjectId) syncTeam(activeProjectId, { force: true });
  };

  const palette =
    source === 'cache'
      ? 'bg-amber-500/15 text-amber-200 border-amber-500/30'
      : 'bg-orange-500/15 text-orange-200 border-orange-500/30';

  const message =
    source === 'cache'
      ? "Showing last-known team — couldn't reach idealvibe."
      : 'Working offline with default team — connect to idealvibe to load yours.';

  return (
    <div className={`flex items-center justify-between gap-3 px-3 py-2 text-sm border ${palette} rounded-lg mx-2 mt-2`}>
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={syncing || !activeProjectId}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
        title={!activeProjectId ? 'No active project' : undefined}
      >
        <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
        Retry
      </button>
    </div>
  );
}
