/**
 * ProjectTeamAssignment.tsx
 * One-active-team-per-project widget. Lives in project detail panel.
 *
 * API: POST/DELETE /v1/projects/{id}/team-assignment
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { Team } from './types';
import { api } from './api';
import './TeamEditor.css';

interface Props {
  projectId: number;
  projectName: string;
}

export const ProjectTeamAssignment: React.FC<Props> = ({ projectId, projectName }) => {
  const [teams, setTeams] = useState<Team[]>([]);
  const [assignedTeamId, setAssignedTeamId] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Load data ─────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch all teams
      const teamsBody = await api.listTeams();
      setTeams(teamsBody.data ?? []);

      // Fetch current assignment for this project
      const projBody = await api.getProject(projectId);
      const teamId = projBody.data?.assignedTeamId ?? null;
      setAssignedTeamId(teamId);
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
  const assign = async () => {
    if (!selectedTeamId || selectedTeamId === assignedTeamId) return;
    setLoading(true);
    try {
      await api.assignTeam(projectId, selectedTeamId);
      setAssignedTeamId(selectedTeamId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Assign failed');
    } finally {
      setLoading(false);
    }
  };

  const unassign = async () => {
    const team = teams.find(t => t.id === assignedTeamId);
    const confirmed = confirm(
      `Remove "${team?.name}" from "${projectName}"?\n\n` +
      `Agents will no longer receive mail for this project.`
    );
    if (!confirmed) return;

    setLoading(true);
    try {
      await api.unassignTeam(projectId);
      setAssignedTeamId(null);
      setSelectedTeamId('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unassign failed');
    } finally {
      setLoading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const assignedTeam = teams.find(t => t.id === assignedTeamId);
  const availableTeams = teams.filter(t => t.id !== assignedTeamId);

  return (
    <div className="project-team-assignment">
      <h4>Team</h4>

      {error && <div className="error-banner">{error}</div>}

      {assignedTeam ? (
        <div className="assigned-team-card">
          <div className="team-badge">🏆 {assignedTeam.name}</div>
          <div className="team-meta">
            {assignedTeam.instances?.length ?? 0} agents
          </div>
          <button
            className="btn-secondary"
            onClick={unassign}
            disabled={loading}
          >
            {loading ? '…' : 'Change Team'}
          </button>
        </div>
      ) : (
        <div className="unassigned-state">
          <p>No team assigned.</p>
          <p className="hint">
            Agents cannot receive project mail until a team is assigned.
          </p>

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
              onClick={assign}
              disabled={loading || !selectedTeamId}
            >
              {loading ? '…' : 'Assign Team'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
