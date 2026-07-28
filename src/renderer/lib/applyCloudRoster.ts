/**
 * Apply the cloud roster (teamStore.cloudAgents, already fetched by
 * syncTeam) to the rendered agents array. Extracted from App.tsx Phase 5
 * (§4.3) so the engage-team CTA can run the SAME application step after an
 * engage — App's Phase 5 effect is keyed on project id and does not refire
 * when only the roster changes (WO-ACP-LIVE-TEAM-MERGE ACP-2).
 *
 * Empty cloud roster is AUTHORITATIVE (Spec AC-9): render the empty grid,
 * never fall through to DEFAULT_AGENTS.
 */
import { agentReconcile } from './agentReconcile';
import { useAppStore } from '../stores/appStore';
import { useTeamStore } from '../stores/teamStore';

export function applyCloudRosterToAgents(): void {
  const cloud = useTeamStore.getState().cloudAgents;
  if (cloud.length === 0) {
    useAppStore.getState().setAgents([]);
    return;
  }
  const localPrefs = useAppStore.getState().settings.agents ?? [];
  const reconciled = agentReconcile(cloud, localPrefs);
  useAppStore.getState().setAgents(reconciled);
  window.electronAPI.setSettings({ agents: reconciled });
}
