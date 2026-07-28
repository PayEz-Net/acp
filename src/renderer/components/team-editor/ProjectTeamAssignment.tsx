/**
 * ProjectTeamAssignment.tsx
 * One-active-team-per-project widget. Lives in project detail panel.
 *
 * Live-team model (WO-ACP-LIVE-TEAM-MERGE ACP-6): assignment state IS the
 * project DTO's `engaged_team_id`, and assignment goes through the EngageTeam
 * route (POST /v1/projects/:id/teams) — the SINGLE assignment path. There is
 * no unassign: swapping teams = engaging another (re-engaging over an
 * existing team without ?confirm=true → 409 ENGAGE_CONFIRM_REQUIRED →
 * consent dialog → re-POST with confirm).
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { Team } from './types';
import { api } from './api';
import { teamDisplayName, extractTeamList, type EngageConflictInfo } from '../../stores/api-helpers';
import './TeamEditor.css';

interface Props {
  projectId: number;
  projectName: string;
}

export const ProjectTeamAssignment: React.FC<Props> = ({ projectId, projectName }) => {
  const [teams, setTeams] = useState<Team[]>([]);
  const [engagedTeamId, setEngagedTeamId] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [changing, setChanging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Load data ─────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch all teams (envelope-tolerant — {data:[…]} / {data:{teams:[…]}}
      // / {teams:[…]}; an assumed list shape would crash the renderer).
      const teamsBody = await api.listTeams();
      setTeams(extractTeamList(teamsBody));

      // Fetch current engagement for this project. The project detail may be
      // nested under data.project (sidecar success envelope) — unwrap like
      // the other consumers do. Read engaged_team_id, NOT a legacy
      // assignment field.
      const projBody = await api.getProject(projectId);
      const proj = projBody.data?.project ?? projBody.data ?? {};
      const teamId = proj.engaged_team_id != null ? String(proj.engaged_team_id) : null;
      setEngagedTeamId(teamId);
      if (teamId) setSelectedTeamId(teamId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const engage = async (confirm: boolean) => {
    if (!selectedTeamId || (!changing && selectedTeamId === engagedTeamId)) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.assignTeam(projectId, selectedTeamId, { confirm });
      if (result.ok) {
        setEngagedTeamId(selectedTeamId);
        setChanging(false);
      } else if ('conflict' in result) {
        // 409 ENGAGE_CONFIRM_REQUIRED — swap consent using the cloud's
        // verbatim current/incoming/lost_overrides, then re-POST confirmed.
        if (confirmSwap(result.conflict)) {
          await engage(true);
        }
      } else {
        setError(result.error);
      }
    } finally {
      setLoading(false);
    }
  };

  const confirmSwap = (conflict: EngageConflictInfo): boolean => {
    const lost = Array.isArray(conflict.lost_overrides) ? conflict.lost_overrides.length : 0;
    return confirm(
      `"${projectName}" already has "${teamDisplayName(conflict.current_team)}" engaged.\n\n` +
      `Swap to "${teamDisplayName(conflict.incoming_team)}"?` +
      (lost > 0 ? `\n\n${lost} per-agent override(s) on the current team will be lost.` : '')
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const engagedTeam = teams.find(t => t.id === engagedTeamId);
  const availableTeams = teams.filter(t => t.id !== engagedTeamId);

  return (
    <div className="project-team-assignment">
      <h4>Team</h4>

      {error && <div className="error-banner">{error}</div>}

      {engagedTeam && !changing ? (
        <div className="assigned-team-card">
          <div className="team-badge">🏆 {engagedTeam.name}</div>
          <div className="team-meta">
            {engagedTeam.instances?.length ?? 0} agents
          </div>
          <button
            className="btn-secondary"
            onClick={() => setChanging(true)}
            disabled={loading}
          >
            Change Team
          </button>
        </div>
      ) : (
        <div className="unassigned-state">
          {!engagedTeam && (
            <>
              <p>No team engaged.</p>
              <p className="hint">
                Agents cannot receive project mail until a team is engaged.
              </p>
            </>
          )}

          <div className="assign-controls">
            <select
              value={selectedTeamId}
              onChange={e => setSelectedTeamId(e.target.value)}
              disabled={loading || availableTeams.length === 0}
            >
              <option value="">Select a team…</option>
              {availableTeams.map(team => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>

            <button
              className="btn-primary"
              onClick={() => engage(false)}
              disabled={loading || !selectedTeamId}
            >
              {loading ? '…' : engagedTeam ? 'Swap Team' : 'Engage Team'}
            </button>

            {changing && (
              <button
                className="btn-secondary"
                onClick={() => {
                  setChanging(false);
                  setSelectedTeamId(engagedTeamId ?? '');
                }}
                disabled={loading}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
