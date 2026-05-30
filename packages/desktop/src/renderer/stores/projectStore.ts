import { create } from 'zustand';
import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import { useAppStore } from './appStore';

// --- Types ---

export interface Project {
  id: number;
  name: string;
  description?: string;
  status: 'active' | 'archived' | 'completed';
  agentProvider?: 'claude' | 'kimi' | 'codex';
  created_at: string;
  updated_at: string;
  // Wave A.1 enriched fields (optional — SSE-derived constructions can omit;
  // fresh fetch from acp-api `/v1/projects/current` carries them all). FE
  // settings panel + always-picker attribute pills consume from here.
  owner_user_id?: number;
  is_active?: boolean;
  member_count?: number;
  team_member_count?: number;
  runtime?: 'claude' | 'kimi' | 'codex';
  target_stack?: string | null;
  auth_method?: string | null;
  repo_path?: string | null;
  goal_summary?: string | null;
  app_type?: string | null;
  signin_choice?: string | null;
  runtime_choice?: 'claude' | 'kimi' | 'codex' | null;
  repo_layout?: string | null;
  stack_topology?: string | null;
  compliance?: unknown[] | null;
  advisor_output?: unknown | null;
}

// Cloud-authoritative current-project resolution state. Spec §5.4.
//   stored — developer_current_project row exists, project loaded normally.
//   unset  — no row, but developer has ≥1 project — picker prompts.
//   empty  — developer has zero projects — create-CTA pointing at idealvibe.
// Wire field name renamed from `active_project_state` per DotNetPert msg
// 1008 rename ship (cloud image 661332fe30ac). The FE store-internal
// concept `activeProject` keeps its name — it's an in-memory selection
// label with no HTTP mirror.
export type CurrentProjectState = 'stored' | 'unset' | 'empty';

// Per-project agent record (from `GET /v1/projects/:id/team`). Mirrors
// the acp-api MappedProjectTeamMember shape (which is itself the cloud
// `vibe_projects.project_team_members` row joined with `vibe_agents.agents`).
// Settings panel team table + Wave C instantiation lifecycle both consume.
export interface ProjectTeamMember {
  agent_id: number;
  agent_name: string;
  agent_display_name: string | null;
  canonical_role: string | null;
  role: string | null;
  runtime_override: 'claude' | 'kimi' | 'codex' | null;
  /** Per-agent Claude effort override (Claude-only). NULL = inherit the single
   *  global default at spawn (pty.ts resolver). Consumed via a-renderer. */
  effort_override: 'low' | 'medium' | 'high' | 'max' | null;
  work_dir_override: string | null;
  position_hint: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | null;
  is_lead: boolean;
  added_at: string;
  added_by: number | null;
}

// FE-derived picker mode. Drives ProjectPicker rendering branches per
// always-picker-on-load directive (BAPert msg 1021 + 1023). Picker is the
// boot front-door every time, regardless of current_project_state — three
// contextual modes:
//   stored-confirm     — current project pre-highlighted, [Start] confirms
//                          (or [Pick another] inline-expands the list).
//   first-boot-prompt  — no default highlight, full list, [Start] enabled
//                          after selection.
//   create-cta         — no list, "Open idealvibe.online to create" link.
// Wave 2 had 'first-boot-prompt' and 'create-cta' only (null = no picker
// shown). Always-picker reframe replaces null-with-picker-hidden with
// 'stored-confirm'-with-picker-shown. The picker is now boot-modal until
// the user clicks [Start], tracked via pickerHasStarted.
export type PickerMode = 'stored-confirm' | 'first-boot-prompt' | 'create-cta';

// --- API helper ---

async function projectRequest(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
  const { method = 'GET', body } = options;
  const secret = await window.electronAPI.getLocalSecret();
  return fetch(`http://127.0.0.1:3001/v1/projects${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
      ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// --- Store ---

interface ProjectStore {
  // State
  projects: Project[];
  activeProject: Project | null;
  currentProjectTeam: ProjectTeamMember[];
  current_project_state: CurrentProjectState | null;
  pickerMode: PickerMode | null;
  // Always-picker boot flag. False on cold load; flips true after the user
  // clicks [Start] in the picker. While false, fetchActiveProject auto-shows
  // the picker so it functions as the boot front-door. Subsequent 60s
  // useTeamPoll ticks update pickerMode + current_project_state but never
  // re-auto-open the picker once the user has confirmed once.
  pickerHasStarted: boolean;
  loading: boolean;
  loadingTeam: boolean;
  showPicker: boolean;
  showSettings: boolean;

  // Actions
  setShowPicker: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  markPickerStarted: () => void;

  // API
  fetchProjects: () => Promise<void>;
  fetchActiveProject: (opts?: { force?: boolean }) => Promise<void>;
  fetchCurrentProjectTeam: (projectId: number, opts?: { force?: boolean }) => Promise<void>;
  switchProject: (projectId: number) => Promise<boolean>;
  // First-pick from picker when current_project_state is 'unset' or
  // 'empty' — thin POST wrapper, no PTY work. Distinct from switchProject
  // which is the fail-loud stub (Wave C replaces with re-instantiation
  // lifecycle for the stored-→-different-stored case where PTYs are running).
  setCurrentProject: (projectId: number) => Promise<boolean>;
  // Explicit user "go": POST /v1/projects/:id/lifecycle {action:'start'}.
  // This is the wire that was never connected — the cloud state machine
  // needs this to transition the project to RUNNING, which the SignalR
  // hub then pushes (and lifecycle-hub's seed reads) so the spawn-
  // orchestrator instantiates the team. Surfaces the cloud's verbatim
  // message on rejection (no swallow).
  startProjectLifecycle: (projectId: number) => Promise<{ ok: boolean; error?: string }>;
  createProject: (name: string, description?: string) => Promise<Project | null>;
  updateProject: (projectId: number, updates: { name?: string; description?: string; status?: string }) => Promise<boolean>;
  deleteProject: (projectId: number) => Promise<boolean>;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  activeProject: null,
  currentProjectTeam: [],
  current_project_state: null,
  pickerMode: null,
  pickerHasStarted: false,
  loading: false,
  loadingTeam: false,
  showPicker: false,
  showSettings: false,

  setShowPicker: (show) => set({ showPicker: show }),
  setShowSettings: (show) => set({ showSettings: show }),

  // Called by ProjectPicker [Start] button — flips the boot flag so future
  // fetchActiveProject ticks won't re-auto-open the picker. Also closes the
  // picker on the same tick. After this, picker only opens via explicit
  // setShowPicker(true) (e.g., title-bar pill click for browse/switch).
  markPickerStarted: () => set({ pickerHasStarted: true, showPicker: false }),

  fetchProjects: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loading: true });
    try {
      const res = await projectRequest('');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const projects: Project[] = data.data?.projects || data.data || [];
      set({ projects, loading: false });
    } catch (err) {
      console.error('[Projects] Failed to fetch projects:', err);
      set({ loading: false });
    }
  },

  fetchCurrentProjectTeam: async (projectId, opts = {}) => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loadingTeam: true });
    try {
      const path = opts.force
        ? `/${projectId}/team?force_refresh=true`
        : `/${projectId}/team`;
      const res = await projectRequest(path);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const team: ProjectTeamMember[] = Array.isArray(data.data?.team) ? data.data.team : [];
      set({ currentProjectTeam: team, loadingTeam: false });
    } catch (err) {
      console.error('[Projects] Failed to fetch project team:', err);
      set({ loadingTeam: false });
    }
  },

  fetchActiveProject: async (opts = {}) => {
    if (!useAppStore.getState().backendAvailable) return;
    try {
      // force=true bypasses the 60s read-through cache. useTeamPoll passes
      // it on every tick so the poll IS the freshness guarantee — not the
      // cache-vs-poll-cadence alignment that v1.5 F3 flagged. Spec §4.6.
      const path = opts.force ? '/current?force_refresh=true' : '/current';
      const res = await projectRequest(path);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const project: Project | null = data.data?.project || null;
      const current_project_state: CurrentProjectState | null =
        data.data?.current_project_state ?? null;

      // Derive picker mode from cloud-authoritative state per BAPert msg
      // 1023 chrome. All three states map to a picker mode; no silent
      // auto-select (feedback_no_unjustified_fallback + always-picker
      // directive feedback_always_picker_on_load).
      let pickerMode: PickerMode | null = null;
      if (current_project_state === 'stored') {
        pickerMode = 'stored-confirm';
      } else if (current_project_state === 'unset') {
        pickerMode = 'first-boot-prompt';
      } else if (current_project_state === 'empty') {
        pickerMode = 'create-cta';
      }

      // Auto-open picker on cold boot (pickerHasStarted=false). Once user
      // has confirmed once via [Start], subsequent fetches (60s poll, SSE
      // resync) keep pickerMode current but don't re-auto-open. User can
      // re-open via title-bar pill click → setShowPicker(true).
      const shouldAutoOpen = !get().pickerHasStarted && pickerMode !== null;
      const showPicker = shouldAutoOpen ? true : get().showPicker;

      set({ activeProject: project, current_project_state, pickerMode, showPicker });
      applyProjectAgentProvider(project);
    } catch (err) {
      console.error('[Projects] Failed to fetch active project:', err);
    }
  },

  switchProject: async (projectId) => {
    // Wave C/2 Commit D/B — delegate to main process via electronAPI.
    // Main handles PUT current-project + boot-overlay write + app.relaunch
    // atomically (project-switch.ts + Aurum R1 lock per BAPert msg 1156).
    // If cloud PUT fails, no relaunch happens; we return false so the
    // picker can surface the error inline. If success, the app restarts
    // before this promise even resolves on the renderer side — the
    // return value is mostly moot for the success path.
    //
    // Name is REQUIRED (Aurum R1 boot overlay needs it for "Switching to
    // <project_name>…"). If the project isn't in our local list,
    // something's drifted — bail loudly rather than guess.
    const targetProject = get().projects.find(p => p.id === projectId);
    if (!targetProject) {
      throw new Error(`Project ${projectId} not found in local list — refresh and try again`);
    }
    try {
      const result = await window.electronAPI.switchProject(projectId, targetProject.name);
      if (!result.success) {
        console.warn(`[Projects] switchProject failed: ${result.errorCode} ${result.errorMessage}`);
        // Throw an error so ProjectPicker's catch block surfaces it inline.
        // The picker reads .message — include the cloud error message.
        throw new Error(result.errorMessage || result.errorCode || 'Switch failed');
      }
      return true;
    } catch (err) {
      // Network or IPC error reaching main process — surface so caller
      // can show inline error. No app relaunch occurred.
      if (err instanceof Error) throw err;
      throw new Error('Failed to switch project');
    }
  },

  setCurrentProject: async (projectId) => {
    // First-pick path from picker: cloud writeback only, no PTY work.
    // Safe because Ship F-bis's boot-ordering gate prevents PTY spawn /
    // mail polling until current_project_state flips to 'stored' — by the
    // time those effects fire, the cloud has accepted the pick and the
    // refetch below has hydrated activeProject.
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      const res = await projectRequest('/current', {
        method: 'POST',
        body: { project_id: projectId },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      // Refetch the current-project state so projectStore reflects the
      // cloud-side flip from 'unset' / 'empty' → 'stored'. This also sets
      // activeProject + pickerMode='stored-confirm' through the same
      // fetchActiveProject derivation used on boot.
      await get().fetchActiveProject({ force: true });
      return true;
    } catch (err) {
      console.error('[Projects] Failed to set current project:', err);
      return false;
    }
  },

  startProjectLifecycle: async (projectId) => {
    if (!useAppStore.getState().backendAvailable) return { ok: false, error: 'Backend not available' };
    try {
      const res = await projectRequest(`/${projectId}/lifecycle`, {
        method: 'POST',
        body: { action: 'start' },
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success !== false) {
        console.log(`[Projects] lifecycle start posted for project=${projectId}`);
        return { ok: true };
      }
      // Surface the cloud's verbatim reason (INCOMPLETE_PROJECT,
      // INVALID_TRANSITION, etc.) — never swallow into a false success.
      const msg = data?.error?.message || data?.message || `Cloud returned HTTP ${res.status}`;
      console.error(`[Projects] lifecycle start failed for project=${projectId}: ${msg}`);
      return { ok: false, error: msg };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Projects] lifecycle start threw:', msg);
      return { ok: false, error: msg };
    }
  },

  createProject: async (name, description) => {
    if (!useAppStore.getState().backendAvailable) return null;
    try {
      const res = await projectRequest('', {
        method: 'POST',
        body: { name, description },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const project: Project = data.data?.project || data.data;
      await get().fetchProjects();
      return project;
    } catch (err) {
      console.error('[Projects] Failed to create project:', err);
      return null;
    }
  },

  updateProject: async (projectId, updates) => {
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      const res = await projectRequest(`/${projectId}`, {
        method: 'PATCH',
        body: updates,
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await get().fetchProjects();
      // Refresh active if we updated it
      if (get().activeProject?.id === projectId) {
        await get().fetchActiveProject();
      }
      return true;
    } catch (err) {
      console.error('[Projects] Failed to update project:', err);
      return false;
    }
  },

  deleteProject: async (projectId) => {
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      const res = await projectRequest(`/${projectId}`, { method: 'DELETE' });
      // 204 = deleted, 404 = already gone (idempotent on dual-invoke);
      // both are success from the user's perspective.
      if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
      await get().fetchProjects();
      return true;
    } catch (err) {
      console.error('[Projects] Failed to delete project:', err);
      return false;
    }
  },

}));

// --- Apply project-driven agent provider ---

function applyProjectAgentProvider(project: Project | null): void {
  if (!project?.agentProvider) return;
  const appStore = useAppStore.getState();
  const currentProvider = appStore.settings.agentProvider;
  if (currentProvider === project.agentProvider) return;

  appStore.setAgentProvider(project.agentProvider);

  const updatedAgents = appStore.settings.agents?.map((a) => ({ ...a, provider: project.agentProvider })) || [];
  window.electronAPI.setSettings({
    agentProvider: project.agentProvider,
    agents: updatedAgents,
  });
  console.log(`[Projects] Agent provider switched to ${project.agentProvider} for project "${project.name}"`);
}

// --- Reload all project-scoped stores ---
// Exported so useTeamPoll can drive the same reflow path as a manual
// project switch when the 60s tick detects a cross-surface change.

export async function reloadProjectScopedStores() {
  const { useKanbanStore } = await import('./kanbanStore');
  const { useContractorStore } = await import('./contractorStore');
  const { useChatStore } = await import('./chatStore');

  const promises: Promise<void>[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kanbanState = useKanbanStore.getState() as any;
  if (typeof kanbanState.fetchTasks === 'function') {
    promises.push(kanbanState.fetchTasks());
  }

  promises.push(useContractorStore.getState().fetchActive());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chatState = useChatStore.getState() as any;
  if (typeof chatState.fetchConversations === 'function') {
    promises.push(chatState.fetchConversations());
  }

  await Promise.allSettled(promises);
}
