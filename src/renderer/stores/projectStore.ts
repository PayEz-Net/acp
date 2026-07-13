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
  runtime_choice?: 'claude' | 'kimi' | null;
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

// Reconcile-on-switch plan (SPEC-team-runtime §3.2/§4). When opening/switching
// a project — or when its team runtime changes — any RUNNING agent on a
// provider != the team runtime must restart to conform. Restarting drops the
// agent's in-flight session, so this is CONFIRM-FIRST: the plan is surfaced and
// the user must approve before any kill (consent-first; silent default = do not
// kill). `agents` is the non-conforming running set (name + the provider it is
// currently on); empty plans are never set (fresh/uniform open → no prompt).
export interface RuntimeReconcilePlan {
  projectId: number;
  teamRuntime: 'claude' | 'kimi' | 'codex';
  agents: Array<{ name: string; from: 'claude' | 'kimi' | 'codex' }>;
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
  // SPEC-workdir-invalid §3.4/§3.5/§3.6 — the SINGLE dedup slice backing the
  // invalid-working-folder surface. BOTH spawn paths write THIS one slice:
  //   • the pre-flight gate (ProjectPicker.triggerStart, §3.5), and
  //   • the orchestrator-path IPC listener (App onPtySpawnFailed, §3.4).
  // So N agents failing on one shared repo_path collapse to ONE
  // WorkdirCorrection surface (dedup key = badPath; BAPert ruling: one active
  // project ⇒ one repo_path, no project_id in the IPC contract). null = no
  // surface. The carried projectId is what the §3.6 fix-forward write targets;
  // it is null ONLY in the §3.4 no-active-project edge (an orchestrator
  // WORKDIR_INVALID arrived before the renderer hydrated a project) — the
  // surface still shows (never swallow), but the inline save is gated.
  workdirInvalid: { projectId: number | null; projectName: string; badPath: string } | null;

  // Reconcile-on-switch confirm plan (SPEC-team-runtime §3.2/§4). Non-null
  // when running agents on the wrong provider need user approval to restart.
  runtimeReconcile: RuntimeReconcilePlan | null;

  // Runtime-not-set block surface (SPEC-team-runtime §3.3). Non-null when an
  // active project's spawn was BLOCKED because it has no team runtime — the
  // user must set one (web) before agents can start. Never a silent default.
  runtimeNotSet: { projectId: number | null; projectName: string } | null;

  // Actions
  setShowPicker: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  markPickerStarted: () => void;
  // First-wins dedup on badPath: once the surface is up for a path, repeat
  // failures (other agents on the SAME repo_path) are absorbed silently so the
  // user sees one surface, not N. A different badPath replaces it.
  setWorkdirInvalid: (issue: { projectId: number | null; projectName: string; badPath: string }) => void;
  clearWorkdirInvalid: () => void;

  // Reconcile-on-switch (SPEC-team-runtime §3.2). Compute which RUNNING agents
  // in `projectId` are on a provider != the team runtime; if any, surface the
  // confirm plan (does NOT restart — consent-first). No-op when nothing is
  // running on the wrong provider (fresh/uniform open). Called at the
  // instantiation moment (picker Start, coupled with the workdir pre-flight
  // gate) and on a detected team-runtime change for the active project.
  reconcileTeamRuntime: (projectId: number) => Promise<void>;
  // User approved the plan: restart each non-conforming agent through the
  // single-authority lifecycle restart route (re-resolves the team runtime
  // server-side). Clears the plan.
  confirmRuntimeReconcile: () => Promise<void>;
  // User declined: leave running agents as-is, clear the plan.
  cancelRuntimeReconcile: () => void;

  // Runtime-not-set block surface (SPEC-team-runtime §3.3).
  setRuntimeNotSet: (issue: { projectId: number | null; projectName: string }) => void;
  clearRuntimeNotSet: () => void;

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
  // Inline workdir fix-forward (SPEC-workdir-invalid §3.6). Writes ONLY
  // repo_path via the authed PUT /v1/projects/:id lane — the acp-api proxy
  // attaches the held session bearer AND sets X-Client-Id from the token's
  // own signed client_id (requireTokenClientId, NOT a hardcoded id — memory
  // rule project_acp_xclientid_from_token_not_hardcoded_9). On success the
  // in-memory activeProject.repo_path is updated so the gated spawn fan-out
  // reads the corrected path. On failure the verbatim cloud error (401/403
  // PROJECT_FORBIDDEN / 400 / etc.) is returned so the caller halts legibly —
  // NO silent fallback (feedback_fallback_to_avoid_crash_is_the_hole).
  updateProjectRepoPath: (projectId: number, repoPath: string) => Promise<{ ok: boolean; error?: string }>;
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
  workdirInvalid: null,
  runtimeReconcile: null,
  runtimeNotSet: null,

  setShowPicker: (show) => set({ showPicker: show }),
  setShowSettings: (show) => set({ showSettings: show }),

  setWorkdirInvalid: (issue) => {
    const cur = get().workdirInvalid;
    // Dedup: an active surface for the same path swallows repeat failures
    // (the orchestrator fires one PTY_SPAWN_FAILED per agent; they share a path).
    if (cur && cur.badPath === issue.badPath) return;
    set({ workdirInvalid: issue });
  },
  clearWorkdirInvalid: () => set({ workdirInvalid: null }),

  setRuntimeNotSet: (issue) => set({ runtimeNotSet: issue }),
  clearRuntimeNotSet: () => set({ runtimeNotSet: null }),

  // SPEC-team-runtime §3.2 — reconcile-on-switch. Renderer-side resolveTeamRuntime
  // = the active project's runtime_choice (the single authority). Find RUNNING
  // agents in this project on a DIFFERENT provider; if any, surface the confirm
  // plan (consent-first — never auto-kill). No-op when nothing is running on the
  // wrong provider (fresh/uniform open → no prompt, per §3.2/§4).
  reconcileTeamRuntime: async (projectId) => {
    if (!useAppStore.getState().backendAvailable) return;
    const proj = get().activeProject;
    if (!proj || proj.id !== projectId) return;
    const teamRuntime = proj.runtime_choice;
    // Unset runtime is NOT a reconcile case — it's the §3.3 block (handled at
    // spawn). Here we only conform running agents to a KNOWN team runtime.
    if (teamRuntime !== 'claude' && teamRuntime !== 'kimi') return;

    let terminals: Array<{ agentName: string; projectId?: number; provider: 'claude' | 'kimi' | 'codex' }> = [];
    try {
      terminals = await window.electronAPI.listTerminals();
    } catch (err) {
      console.error('[Projects] reconcileTeamRuntime: listTerminals failed:', err);
      return;
    }

    const teamNames = new Set((get().currentProjectTeam ?? []).map((m) => m.agent_name));
    const seen = new Set<string>();
    const agents = terminals
      // Scope to this project (legacy terminals carry no projectId — include
      // them by name when they match the team, since name is the bind key).
      .filter((t) => t.projectId == null || t.projectId === projectId)
      .filter((t) => teamNames.size === 0 || teamNames.has(t.agentName))
      .filter((t) => t.provider !== teamRuntime)
      .filter((t) => (seen.has(t.agentName) ? false : (seen.add(t.agentName), true)))
      .map((t) => ({ name: t.agentName, from: t.provider }));

    if (agents.length === 0) {
      // Fresh/uniform open — nothing to conform, no prompt (§4). Clear any
      // stale plan so a previous decline doesn't linger.
      if (get().runtimeReconcile) set({ runtimeReconcile: null });
      return;
    }
    // Restarting drops in-flight work → confirm-first (§3.2/§4). Surface the
    // plan; the dialog drives confirm/cancel. Do NOT kill here.
    set({ runtimeReconcile: { projectId, teamRuntime, agents } });
  },

  // SPEC-team-runtime §3.2/§4 — user approved. Restart each non-conforming
  // agent through the single-authority lifecycle restart route (it re-resolves
  // the team runtime server-side and kills+respawns under it — the renderer
  // never re-derives the runtime). The PTY_SPAWNED listener (App) rebinds the
  // new terminalId per agent.
  confirmRuntimeReconcile: async () => {
    const plan = get().runtimeReconcile;
    if (!plan) return;
    set({ runtimeReconcile: null });
    if (!useAppStore.getState().backendAvailable) return;
    const secret = await window.electronAPI.getLocalSecret();
    const appStore = useAppStore.getState();
    for (const a of plan.agents) {
      try {
        const ag = appStore.agents.find((x) => x.name === a.name);
        if (ag) appStore.updateAgentStatus(ag.id, 'starting');
        const res = await fetch(`http://127.0.0.1:3001/v1/lifecycle/agents/${encodeURIComponent(a.name)}/restart`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
            ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          },
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          console.error(`[Projects] reconcile restart ${a.name} failed: ${data?.error?.message || res.status}`);
          if (ag) appStore.updateAgentStatus(ag.id, 'error');
        } else {
          console.log(`[Projects] reconciled ${a.name}: ${a.from} -> ${plan.teamRuntime}`);
        }
      } catch (err) {
        console.error(`[Projects] reconcile restart ${a.name} threw:`, err);
      }
    }
  },

  cancelRuntimeReconcile: () => set({ runtimeReconcile: null }),

  // Called by ProjectPicker [Start] button — flips the boot flag so future
  // fetchActiveProject ticks won't re-auto-open the picker. Also closes the
  // picker on the same tick. After this, picker only opens via explicit
  // setShowPicker(true) (e.g., title-bar pill click for browse/switch).
  markPickerStarted: () => set({ pickerHasStarted: true, showPicker: false }),

  fetchProjects: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loading: true });
    try {
      // force_refresh=true bypasses the acp-api read-through cache so the
      // picker reflects cloud reality (new projects, renames, archived state).
      const res = await projectRequest('?force_refresh=true');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      console.log('[Projects] fetchProjects raw:', JSON.stringify(data.data));
      const projects: Project[] = data.data?.projects || data.data || [];

      const { activeProject } = get();
      if (activeProject && projects.length > 0 && !projects.some(p => p.id === activeProject.id)) {
        // The stored current project is no longer in the active project list
        // (deleted, archived, or cross-tenant). Clear the cloud pointer so the
        // picker surfaces the real active projects instead of a ghost project.
        console.warn('[Projects] Active project', activeProject.id, 'not in active list; clearing pointer');
        try {
          await projectRequest('/current', { method: 'POST', body: { project_id: null } });
          set({
            projects,
            activeProject: null,
            current_project_state: projects.length > 0 ? 'unset' : 'empty',
            pickerMode: projects.length > 0 ? 'first-boot-prompt' : 'create-cta',
            loading: false,
          });
          return;
        } catch (clearErr) {
          console.error('[Projects] Failed to clear stale current project:', clearErr);
        }
      }

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
      let project: Project | null = data.data?.project || null;
      const current_project_state: CurrentProjectState | null =
        data.data?.current_project_state ?? null;

      console.log('[Projects] fetchActiveProject raw:', JSON.stringify(data.data));

      // Never surface an inactive/archived/completed project as the startup
      // project. If the cloud pointer drifted to an inactive row, clear it.
      if (project && project.status !== 'active') {
        console.warn('[Projects] Current project is inactive; clearing pointer', project.id, project.status);
        try {
          await projectRequest('/current', { method: 'POST', body: { project_id: null } });
          project = null;
        } catch (clearErr) {
          console.error('[Projects] Failed to clear inactive current project:', clearErr);
        }
      }

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

      // Capture the prior team runtime BEFORE overwriting, to detect an
      // in-session change (web/CLI edited runtime_choice) for reconcile.
      const prev = get().activeProject;

      set({ activeProject: project, current_project_state, pickerMode, showPicker });
      applyProjectAgentProvider(project);

      // SPEC-team-runtime §3.2 — reconcile on a detected team-runtime CHANGE
      // for the already-running active project. Fires once on the change
      // (not every 60s poll), so a declined reconcile isn't re-prompted until
      // the runtime actually changes again. Only when the team is instantiated
      // (pickerHasStarted) — otherwise the open-path coupling handles it.
      if (
        project &&
        prev &&
        prev.id === project.id &&
        prev.runtime_choice !== project.runtime_choice &&
        get().pickerHasStarted
      ) {
        void get().reconcileTeamRuntime(project.id);
      }
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

  updateProjectRepoPath: async (projectId, repoPath) => {
    if (!useAppStore.getState().backendAvailable) {
      return { ok: false, error: 'Backend not available' };
    }
    try {
      // PUT (not PATCH) — PATCH /:id is 410 GONE per the Wave A.1 contract;
      // the rich-field writeback (incl. repo_path) rides PUT /v1/projects/:id.
      // Field-omit = keep current, so we send repo_path alone.
      const res = await projectRequest(`/${projectId}`, {
        method: 'PUT',
        body: { repo_path: repoPath },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.success === false) {
        // Surface the cloud's verbatim reason (PROJECT_FORBIDDEN / validation /
        // not-authenticated). Do NOT swallow into a false success.
        const msg = data?.error?.message || data?.message || `Cloud returned HTTP ${res.status}`;
        console.error(`[Projects] repo_path writeback failed for project=${projectId}: ${msg}`);
        return { ok: false, error: msg };
      }
      // Reflect the corrected path in the in-memory active project so the
      // gated spawn fan-out (which reads activeProject.repo_path) uses it.
      const current = get().activeProject;
      if (current?.id === projectId) {
        set({ activeProject: { ...current, repo_path: repoPath } });
      }
      // Keep the project list copy in sync too (picker pills, etc.). This stores
      // the cloud-ACCEPTED repo_path onto the matching project record — it does
      // NOT compose or resolve a workdir (the single authority for that stays
      // pty.ts resolveWorkDir). Written as an explicit map body, not an inline
      // ternary, so it's plainly a value-store, not a path composition
      // (workspace-debt guard B2).
      set({
        projects: get().projects.map((p) => {
          if (p.id !== projectId) return p;
          return { ...p, repo_path: repoPath };
        }),
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Projects] repo_path writeback threw:', msg);
      return { ok: false, error: msg };
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
