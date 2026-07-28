/**
 * TeamEditor.tsx
 * Main team management screen. Lists all teams with inline agent instance management.
 *
 * API base: local acp-api sidecar /v1/teams (bearer proxy for the cloud's
 * relational standing-team routes — WO-ACP-LIVE-TEAM-MERGE ACP-6)
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { Team, AgentInstance } from './types';
import { AgentInstanceForm } from './AgentInstanceForm';
import { SkillChipRow } from '../Skills';
import { InlineEditField } from './InlineEditField';
import { useAppStore } from '../../stores/appStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { extractTeamList } from '../../stores/api-helpers';
import { api } from './api';
import './TeamEditor.css';

export const TeamEditor: React.FC = () => {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingInstance, setEditingInstance] = useState<AgentInstance | null>(null);
  const [showFormForTeam, setShowFormForTeam] = useState<string | null>(null);

  const { addNotification } = useNotificationStore();

  // ── Fetch teams ───────────────────────────────────────────────────────────
  const fetchTeams = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await api.listTeams();
      // Envelope-tolerant (shared helper) + deduplicate by ID as a safety
      // net (see WO-duplicate-render-bug-fix.md)
      const unique = Array.from(
        new Map(extractTeamList(body).map((t: Team) => [t.id, t])).values()
      );
      setTeams(unique);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load teams');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTeams();
  }, [fetchTeams]);

  // ── Team CRUD ─────────────────────────────────────────────────────────────
  const createTeam = async () => {
    const name = prompt('Team name:');
    if (!name) return;
    try {
      await api.createTeam(name);
      await fetchTeams();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    }
  };

  const renameTeam = async (teamId: string) => {
    const team = teams.find(t => t.id === teamId);
    const name = prompt('New team name:', team?.name);
    if (!name || name === team?.name) return;
    try {
      await api.renameTeam(teamId, name);
      await fetchTeams();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed');
    }
  };

  const deleteTeam = async (teamId: string) => {
    const team = teams.find(t => t.id === teamId);
    const confirmed = confirm(
      `Delete team "${team?.name}"?\n\n` +
      `This cannot be undone. If this team is assigned to any project, ` +
      `you must unassign it first.`
    );
    if (!confirmed) return;
    try {
      await api.deleteTeam(teamId);
      await fetchTeams();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  // ── Instance CRUD ─────────────────────────────────────────────────────────
  const removeInstance = async (teamId: string, instanceId: string) => {
    const confirmed = confirm('Remove this agent from the team?');
    if (!confirmed) return;
    try {
      await api.removeInstance(teamId, instanceId);
      await fetchTeams();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed');
    }
  };

  const onFormSave = async (teamId: string, data: unknown, instanceId?: string) => {
    try {
      if (instanceId) {
        await api.updateInstance(teamId, instanceId, data);
      } else {
        await api.addInstance(teamId, data);
      }
      setShowFormForTeam(null);
      setEditingInstance(null);
      await fetchTeams();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const updateInstanceField = async (
    teamId: string,
    instanceId: string,
    payload: Partial<AgentInstance>
  ) => {
    try {
      await api.updateInstance(teamId, instanceId, payload);
      await fetchTeams();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Update failed';
      addNotification({
        type: 'system',
        title: 'Update failed',
        message: msg,
        agent: 'NextPert',
      });
      throw e;
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="team-editor">
      <header className="team-editor-header">
        <h2>Teams</h2>
        <button className="btn-primary" onClick={createTeam}>
          + New Team
        </button>
      </header>

      {loading && <div className="loading">Loading teams…</div>}
      {error && <div className="error-banner">{error}</div>}

      <div className="team-list">
        {teams.map(team => (
          <TeamCard
            key={team.id} // stable ID — never index
            team={team}
            onRename={() => renameTeam(team.id)}
            onDelete={() => deleteTeam(team.id)}
            onAddAgent={() => {
              setEditingInstance(null);
              setShowFormForTeam(team.id);
            }}
            onEditInstance={(inst) => {
              setEditingInstance(inst);
              setShowFormForTeam(team.id);
            }}
            onRemoveInstance={(inst) => removeInstance(team.id, inst.id)}
            onUpdateInstance={(instId, payload) =>
              updateInstanceField(team.id, instId, payload)
            }
          />
        ))}
      </div>

      {showFormForTeam && (
        <AgentInstanceForm
          teamId={showFormForTeam}
          instance={editingInstance}
          onSave={(data) => onFormSave(showFormForTeam, data, editingInstance?.id)}
          onCancel={() => {
            setShowFormForTeam(null);
            setEditingInstance(null);
          }}
        />
      )}
    </div>
  );
};

// ── Sub-components ──────────────────────────────────────────────────────────

interface TeamCardProps {
  team: Team;
  onRename: () => void;
  onDelete: () => void;
  onAddAgent: () => void;
  onEditInstance: (inst: AgentInstance) => void;
  onRemoveInstance: (inst: AgentInstance) => void;
  onUpdateInstance: (instanceId: string, payload: Partial<AgentInstance>) => Promise<void>;
}

const TeamCard: React.FC<TeamCardProps> = ({
  team,
  onRename,
  onDelete,
  onAddAgent,
  onEditInstance,
  onRemoveInstance,
  onUpdateInstance,
}) => {
  const showSkillChips = useAppStore((s) => s.settings?.showSkillChips ?? false);

  return (
    <div className="team-card">
      <div className="team-card-header">
        <h3>🏆 {team.name}</h3>
        <div className="team-card-actions">
          <button className="btn-icon" onClick={onRename} title="Rename">
            ✏️
          </button>
          <button className="btn-icon" onClick={onDelete} title="Delete">
            🗑️
          </button>
        </div>
      </div>

      <div className="team-card-body">
        <p className="team-meta">Agents ({team.instances?.length ?? 0})</p>

        <ul className="instance-list">
          {(team.instances ?? []).map(inst => (
            <li key={inst.id} className="instance-row">
              <div className="instance-info">
                <span className="instance-avatar">👤</span>
                <div className="flex-1 min-w-0">
                  {/* #207 one-name: the member's name IS the canonical agent
                      name (team_unique_name is gone) — plain label, no inline
                      rename / uniqueness check. */}
                  <div className="instance-name">
                    <span className="instance-name-text">{inst.name}</span>
                  </div>
                  <div className="instance-role">
                    <InlineEditField
                      value={inst.displayName || ''}
                      onSave={(val) =>
                        onUpdateInstance(inst.id, { displayName: val })
                      }
                      validate={(val) => {
                        if (!val) return 'Display name is required';
                        return null;
                      }}
                      className="instance-role-text"
                      placeholder="Display name"
                    />
                    {' · '}
                    <InlineEditField
                      value={inst.role || ''}
                      onSave={(val) =>
                        onUpdateInstance(inst.id, { role: val })
                      }
                      validate={(val) => {
                        if (!val) return 'Role is required';
                        return null;
                      }}
                      className="instance-role-text"
                      placeholder="Role"
                    />
                  </div>
                  {showSkillChips && (
                    <div className="mt-1">
                      <SkillChipRow skills={inst.skills ?? []} onChange={() => {}} />
                    </div>
                  )}
                </div>
              </div>
              <div className="instance-actions">
                <button
                  className="btn-text"
                  onClick={() => onEditInstance(inst)}
                >
                  ⚙️ Edit
                </button>
                <button
                  className="btn-text danger"
                  onClick={() => onRemoveInstance(inst)}
                >
                  🗑️
                </button>
              </div>
            </li>
          ))}
        </ul>

        <button className="btn-secondary" onClick={onAddAgent}>
          + Add Agent from Archetype
        </button>
      </div>
    </div>
  );
};
