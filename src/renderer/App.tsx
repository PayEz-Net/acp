import { useEffect, useState } from 'react';
import { MailSidebar } from './components/Mail';
import { LoginScreen, TwoFactorScreen, SessionExpiredOverlay } from './components/Auth';
import { SplashScreen } from './components/SplashScreen';
import { TerminalGrid } from './components/Terminal/TerminalGrid';
import { ReplayPanel } from './components/Terminal/ReplayPanel';
import { TitleBar } from './components/Layout/TitleBar';
// import { TeamSyncBanner } from './components/Layout/TeamSyncBanner'; // disabled — see mount-site comment below
import { KanbanBoard } from './components/Kanban/KanbanBoard';
import { LogViewer } from './components/Logs/LogViewer';
import { ChatPanel } from './components/Chat/ChatPanel';
import { CheckinPanel } from './components/Checkin/CheckinPanel';
import { DocumentSidebar, DocumentModal } from './components/Documents';
import { ContractorPanel } from './components/Contractors';
import { ProjectPicker } from './components/Projects';
import { TeamEditor } from './components/team-editor';
import { ProjectSettingsPanel } from './components/Projects/ProjectSettingsPanel';
import { WelcomeModal } from './components/WelcomeModal';
import { TeamBuilderModal } from './components/SpecialistLibrary';
import { UnattendedBanner, EmergencyStopButton } from './components/Autonomy';
import { BackendStatusBanner } from './components/Layout/BackendStatusBanner';
import { WorkdirCorrection } from './components/Layout/WorkdirCorrection';
import { RuntimeReconcileDialog } from './components/Layout/RuntimeReconcileDialog';
import { RuntimeNotSet } from './components/Layout/RuntimeNotSet';
import { EngageTeamCTA } from './components/Layout/EngageTeamCTA';
import { OverlayPanel } from './components/Layout/OverlayPanel';
import { AgentConfig, AgentSessionStartFailedPayload } from '@shared/types';
import type { AcpEventPayload } from '@shared/acpTypes';
import { useAppStore } from './stores/appStore';
import { useDocumentStore } from './stores/documentStore';
import { useProjectStore } from './stores/projectStore';
import { useAuthStore, AuthFlowState } from './stores/authStore';
import { useTeamStore } from './stores/teamStore';
import { useAcpSessionStore } from './stores/acpSessionStore';
import { useAgentOutputStore } from './stores/agentOutputStore';
import { useNotificationStore } from './stores/notificationStore';
import { useAcpSse } from './hooks/useAcpSse';
import { useVsqlCacheSse } from './hooks/useVsqlCacheSse';
import { useTerminalFrames } from './hooks/useTerminalFrames';
import { useTeamPoll } from './hooks/useTeamPoll';
import { applyCloudRosterToAgents } from './lib/applyCloudRoster';

// Spec §4.4 — local fallback fires only when localhost acp-stable-api is
// unreachable. Backend `team.ts` owns the same BAPert+QAPert seed when
// cloud is down + cache cold (Decision 3a). The two literals must agree.
const DEFAULT_AGENTS = [
  { id: '1', name: 'BAPert', displayName: 'BAPert', workDir: '', autoStart: false, position: 'top-left' as const, color: '#8b5cf6' },
  { id: '2', name: 'QAPert', displayName: 'QAPert', workDir: '', autoStart: false, position: 'top-right' as const, color: '#f59e0b' },
];

export default function App() {
  const { agents, showSidebar, toggleSidebar, showKanban, toggleKanban, showChat, toggleChat, showStandup, toggleStandup, showContractors, toggleContractors, showTeamEditor, toggleTeamEditor, showLogs, toggleLogs, activeAgentId, setAgents, setSettings } = useAppStore();
  const { showDocuments, toggleDocuments } = useDocumentStore();
  const { showPicker, setShowPicker, showSettings, setShowSettings, fetchActiveProject, fetchProjects, activeProject, pickerHasStarted, workdirInvalid, noTeamEngaged } = useProjectStore();
  const { showTeamBuilder, toggleTeamBuilder } = useAppStore();
  const { authFlowState, isLoading: authLoading, loadStatus, user } = useAuthStore();
  const isAuthenticated = authFlowState === AuthFlowState.AUTHENTICATED;
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [showWelcome, setShowWelcome] = useState(false);

  // Find active agent name for mail composition
  const activeAgent = agents.find((a) => a.id === activeAgentId);

  // Wave C/2 Commit D/A — fade out the boot overlay on React mount
  // and clear the next-boot flag so the next cold boot doesn't fire
  // a stale overlay. The pre-mount script in index.html painted the
  // overlay synchronously before this component mounted; we own the
  // dismiss path (Aurum R1 lock per BAPert msg 1156).
  useEffect(() => {
    const el = document.getElementById('boot-overlay');
    if (!el || !el.classList.contains('visible')) return;
    // Cancel the 10s timeout-hint timer if it's still pending.
    const timerId = (el as HTMLElement).dataset?.timeoutTimerId;
    if (timerId) {
      try { clearTimeout(Number(timerId)); } catch { /* ignore */ }
    }
    // Add fade-out class (CSS handles 200ms opacity transition), then
    // hide entirely on transition end so the overlay doesn't intercept
    // pointer events afterward.
    el.classList.add('fade-out');
    const onDone = () => { el.classList.remove('visible'); el.classList.remove('fade-out'); };
    el.addEventListener('transitionend', onDone, { once: true });
    // Clear the persisted flag so subsequent cold boots don't paint
    // the overlay again unless a fresh switch was committed.
    try { window.electronAPI?.clearNextBootOverlay?.(); } catch { /* ignore */ }
    return () => { el.removeEventListener('transitionend', onDone); };
  }, []);

  // Load auth status on mount
  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Load settings after auth
  useEffect(() => {
    if (!isAuthenticated || settingsLoaded) return;

    async function loadSettings() {
      try {
        const settings = await window.electronAPI.getSettings();
        setSettings(settings);
        // NOTE: do NOT setAgents(settings.agents) here. Persisted agents from
        // a prior session would shadow Phase 5's cloud-driven team-sync,
        // causing useMail polling and PTY auto-spawn to fire BEFORE the
        // current_project_state picker resolves (Ship F-bis bug per BAPert
        // msg 1052). Phase 5 (gated on activeProject) is the canonical
        // agents setter — stale-data hydration here was shadowing it.
      } catch (err) {
        console.error('Failed to load settings, using defaults:', err);
        setAgents(DEFAULT_AGENTS);
        setSettings({ layout: 'grid', focusAgent: 'BAPert', showSidebar: true, windowBounds: { x: 100, y: 100, width: 1200, height: 800 }, agents: DEFAULT_AGENTS, mailPollInterval: 30000, theme: 'dark', sidebarWidth: 320, environment: 'prod', enableTerminalImagePaste: true, instantSendPastedImages: false });
      } finally {
        // Task #11 — show welcome modal on first run after settings load
        const s = await window.electronAPI.getSettings();
        if (!s.hasSeenWelcome) {
          setShowWelcome(true);
        }
        setSettingsLoaded(true);
      }
    }
    loadSettings();
  }, [isAuthenticated, settingsLoaded, setSettings, setAgents]);

  // Bootstrap backend status — query main process and listen for changes
  useEffect(() => {
    if (!window.electronAPI?.getBackendStatus) {
      console.warn('[App] electronAPI.getBackendStatus not available');
      return;
    }

    // Initial check
    window.electronAPI.getBackendStatus().then(({ available }) => {
      console.log(`[App] Backend status on boot: ${available}`);
      useAppStore.getState().setBackendAvailable(available);
    }).catch(err => console.error('[App] Failed to get backend status:', err));

    // Listen for crash recovery / status changes from main process
    const unsubscribe = window.electronAPI.onBackendStatusChanged(({ available, message }) => {
      console.log(`[App] Backend status changed: ${available}${message ? ` (${message})` : ''}`);
      useAppStore.getState().setBackendAvailable(available);

      // Task #17 — DO NOT refresh auth token on backend reconnect.
      // Token refresh is main-process single authority (BAPert WO). The
      // renderer calling refreshToken() here caused spurious logouts when the
      // sidecar restarted (lost in-memory session) and the renderer-side
      // logout-on-failure path fired. Main's background timer recovers
      // automatically; if it truly can't refresh after 5 attempts, main
      // broadcasts session-dead which the renderer should listen for.
      // c812789 follow-up / NextPert refresh-token fix.
    });

    // Listen for terminal session-dead from main (max refresh failures reached)
    const unsubscribeSessionDead = window.electronAPI.onAuthSessionDead(({ error }) => {
      console.log('[App] Session dead signal from main:', error);
      // WO (in-app re-login): do NOT logout() — that unmounts to LoginScreen and
      // KILLS every agent pane + its context. markSessionExpired() keeps the app
      // mounted (panes survive) and flips the avatar to 🔴 in-place re-login.
      useAuthStore.getState().markSessionExpired();
    });

    return () => {
      unsubscribe();
      unsubscribeSessionDead();
    };
  }, []);

  // WO (auth indicator): liveness poll BACKSTOP for the avatar indicator — catches
  // a session death even if main's AUTH_SESSION_DEAD broadcast was missed (e.g. the
  // renderer mounted after it fired). Polls ONLY while we believe we're live, so a
  // dead session is never poll-stormed (once 🔴, the user re-logs in via the avatar),
  // and it only DOWNGRADES AUTHENTICATED→SESSION_EXPIRED (markSessionExpired no-ops on
  // cold-start). The event above is the immediate flip; this is the slow safety net.
  useEffect(() => {
    if (authFlowState !== AuthFlowState.AUTHENTICATED) return;
    if (!window.electronAPI?.authGetStatus) return;
    const id = setInterval(async () => {
      try {
        const status = await window.electronAPI.authGetStatus();
        if (!status.isAuthenticated) useAuthStore.getState().markSessionExpired();
      } catch {
        /* transient IPC/status hiccup — the next tick or the dead-event catches it */
      }
    }, 120_000);
    return () => clearInterval(id);
  }, [authFlowState]);

  // Bind panes to spawn-orchestrator-spawned terminals. The orchestrator
  // spawns PTYs in main and the renderer never called pty:spawn, so the
  // agent has no terminalId and the pane sits idle ("Press ▷") while a
  // live Claude session runs behind it. Main now emits pty:spawned with
  // agentName→terminalId; map it onto the agent so TerminalPane's
  // terminalId-gated effects attach the UnifiedTerminal surface to the running PTY.
  useEffect(() => {
    const unsub = window.electronAPI.onAgentSpawned(({ agentName, terminalId, provider }) => {
      const st = useAppStore.getState();
      const agent = st.agents.find((a) => a.name === agentName);
      if (!agent) return;
      const providerChanged = provider && agent.runtimeProvider !== provider;
      if (agent.terminalId !== terminalId || providerChanged) {
        console.log(`[App] orchestrator spawned ${agentName} → terminal=${terminalId} provider=${provider}; binding pane`);
        if (agent.terminalId !== terminalId) {
          st.setAgentTerminalId(agent.id, terminalId);
        }
        if (providerChanged) {
          st.setAgentRuntimeProvider(agent.id, provider as AgentConfig['provider']);
        }
      }
    });
    return unsub;
  }, []);

  // SPEC-workdir-invalid §3.4 — orchestrator-path parity. The main-process
  // spawn-orchestrator (lifecycle-hub RUNNING → orchestrator) has NO renderer
  // fetch to catch a WorkDirError, so main emits PTY_SPAWN_FAILED. Route it to
  // the SAME shared slice the §3.5 pre-flight gate sets, so an orchestrator-path
  // failure renders the one WorkdirCorrection surface (no orphaned main-side
  // failure, no opaque 500). Dedup lives in setWorkdirInvalid (first-wins on
  // badPath) → N agents failing on one repo_path = ONE surface. projectId is
  // resolved from the active project (BAPert ruling: one active project ⇒ one
  // repo_path; the IPC contract carries no project_id) so the §3.6 fix-forward
  // write-back has a target. No active project ⇒ nothing to fix-forward; log.
  useEffect(() => {
    const unsub = window.electronAPI.onPtySpawnFailed((payload) => {
      // SPEC-team-runtime §3.3 — active project with no team runtime: the
      // spawn was BLOCKED (no silent provider). Surface "team runtime not
      // set" rather than dropping it; never swallow (consent/no-guess).
      if (payload.code === 'RUNTIME_NOT_SET') {
        const proj = useProjectStore.getState().activeProject;
        useProjectStore.getState().setRuntimeNotSet({
          projectId: payload.project_id ?? proj?.id ?? null,
          projectName: proj?.name ?? 'the current project',
        });
        return;
      }
      if (payload.code !== 'WORKDIR_INVALID') return;
      const proj = useProjectStore.getState().activeProject;
      // Never swallow a WORKDIR_INVALID (§3.4 no-orphaned-main-side-failures).
      // Normal case: the active project supplies the id the §3.6 write targets.
      // Edge: the orchestrator fired before the renderer hydrated a project —
      // still surface it (projectId=null gates the inline save → Pick another),
      // rather than dropping it to a console.warn.
      if (!proj) {
        console.warn(`[App] PTY_SPAWN_FAILED WORKDIR_INVALID (${payload.work_dir}) with no hydrated active project — surfacing without inline-save target`);
      }
      useProjectStore.getState().setWorkdirInvalid({
        projectId: proj?.id ?? null,
        projectName: proj?.name ?? 'the current project',
        badPath: payload.work_dir ?? '',
      });
    });
    return unsub;
  }, []);

  // ACP (Agent Client Protocol) event stream — forward structured JSON-RPC
  // session/update notifications into the per-agent ACP session store.
  // Events are batched and flushed in a macrotask so a flood of runtime
  // notifications (e.g., BAPert stuck in a tight chunk loop) cannot trigger
  // React's maximum update depth warning or freeze the renderer mid-render.
  useEffect(() => {
    const pending: AcpEventPayload[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      flushTimer = null;
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      const counts: Record<string, number> = {};
      for (const ev of batch) {
        counts[ev.agent] = (counts[ev.agent] || 0) + 1;
      }
      console.log(`[App] Applying ACP event batch: ${batch.length} events`, counts);
      useAcpSessionStore.getState().applyEvents(batch);
    };

    const unsub = window.electronAPI.onAcpEvent((payload) => {
      pending.push(payload);
      if (!flushTimer) {
        flushTimer = setTimeout(flush, 0);
      }
    });

    return () => {
      unsub();
      if (flushTimer) clearTimeout(flushTimer);
      flush();
    };
  }, []);

  // Surface PayEzVibe agent session start failures in the UI. The lifecycle
  // call is non-fatal to the spawn, but a silent warning leaves the user
  // wondering why the agent-output stream returns 400.
  useEffect(() => {
    const unsub = window.electronAPI.onAgentSessionStartFailed((payload: AgentSessionStartFailedPayload) => {
      useNotificationStore.getState().addNotification({
        type: 'system',
        title: `Agent session failed — ${payload.agentName}`,
        message: payload.message,
        agent: payload.agentName,
      });
      useAgentOutputStore.getState().addLine({
        agent: payload.agentName,
        terminal_id: payload.terminalId,
        line: payload.message,
        ts: new Date().toISOString(),
        source: 'info',
      });
    });
    return unsub;
  }, []);

  // Phase 4 — load current project once backend is available.
  // Auto-select-when-1 was deleted in Wave 2: the cloud now returns
  // current_project_state:'unset' when the developer has projects but no
  // current-project row, and the picker prompts the user to pick. Memory
  // rule feedback_no_unjustified_fallback — pro devs choose, even with
  // one project. Spec §5.4.
  // Gate on isAuthenticated AND re-fire when it flips true: the OAuth +
  // external-session handshake completes AFTER boot, so fetching pre-auth
  // 401s ("No active IDP session") and never recovered. isAuthenticated in
  // the deps makes this re-run once the sidecar actually has the session.
  // force=true on the initial fetch so the picker reflects the cloud's
  // current-project pointer, not a stale acp-api cache from a prior session.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (!settingsLoaded) return;
    fetchActiveProject({ force: true });
    fetchProjects();
  }, [isAuthenticated, settingsLoaded, fetchActiveProject, fetchProjects]);

  // Phase 5 — sync the team for the active project, then reconcile against
  // local UI prefs. Spec §4.3. Re-runs on project switch via the dependency
  // on `activeProject?.id`. The reconcile output is what the grid renders;
  // we also persist it back to electron-store so layout/color survive boots.
  // Gated on pickerHasStarted (WO 1560 R3): a returning user has activeProject
  // set immediately on boot, so without this guard the team — and the per-agent
  // mail fetches it feeds — would instantiate BEHIND the still-open confirm
  // picker, before [Start]. pickerHasStarted is in the deps so this fires the
  // moment the user confirms.
  useEffect(() => {
    if (!settingsLoaded || !activeProject || !pickerHasStarted) return;
    let cancelled = false;
    (async () => {
      // Load BOTH team surfaces before the grid mounts. syncTeam feeds the
      // roster (applyCloudRoster below); fetchCurrentProjectTeam feeds the
      // override-carrying member rows (/v1/projects/:id/team —
      // effort_override/model_override) that pane autoStart POSTs at spawn.
      // Without the second, currentProjectTeam stays [] and every boot spawn
      // launches plain (no -m / effort reaches the CLI).
      await Promise.all([
        useTeamStore.getState().syncTeam(activeProject.id),
        useProjectStore.getState().fetchCurrentProjectTeam(activeProject.id),
      ]);
      if (cancelled) return;
      // Spec AC-9: empty cloud roster is authoritative — applyCloudRoster
      // renders the empty grid; it never falls through to DEFAULT_AGENTS.
      // Under the live-team model an empty roster + engaged_team_id == null
      // shows the engage CTA (render branch below) instead of the grid.
      applyCloudRosterToAgents();
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsLoaded, activeProject?.id, pickerHasStarted]);

  // ACP-2 (WO-ACP-LIVE-TEAM-MERGE) — the orchestrator aborted a spawn because
  // the project has NO engaged standing team (empty roster = fresh-project
  // default, not an error). Route the typed IPC into the projectStore slice so
  // the "No team engaged — pick a team" CTA surfaces instead of a silent
  // console.warn. Also force-refresh the DTO so engaged_team_id tracks reality.
  useEffect(() => {
    if (!window.electronAPI?.onNoTeamEngaged) return;
    const unsub = window.electronAPI.onNoTeamEngaged((payload) => {
      const proj = useProjectStore.getState().activeProject;
      useProjectStore.getState().setNoTeamEngaged({
        projectId: payload.project_id ?? proj?.id ?? null,
        projectName: payload.project_name || proj?.name || 'the current project',
      });
      void useProjectStore.getState().fetchActiveProject({ force: true });
    });
    return unsub;
  }, []);

  // Phase 1b: Single centralized SSE connection through acp-api (mail / lifecycle events)
  useAcpSse();

  // BAPert #10583: vsql-cache agent-output stream
  useVsqlCacheSse();

  // Local screen-model frames (main-process PTY screen model). PTY-mode
  // panes render these instead of the cloud stream; useVsqlCacheSse skips
  // frame-backed terminals so the two paths never double-render.
  useTerminalFrames();

  // 60s background poll — keeps active-project + team auto-converged
  // across surfaces (web GSD / CLI → desktop). Spec §4.6 / Decision 7.
  useTeamPoll();

  // Show splash screen on initial load
  if (showSplash) {
    return <SplashScreen onComplete={() => setShowSplash(false)} />;
  }

  // Show loading while auth is initializing
  if (authLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-acp-bg">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-vibe-500/30 border-t-vibe-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-acp-text-secondary">Loading...</p>
        </div>
      </div>
    );
  }

  // Show login screen ONLY for a cold/never-authenticated state (no user). A
  // mid-session death (SESSION_EXPIRED) or a failed in-place re-login (ERROR with
  // `user` still set) must NOT unmount to LoginScreen — that kills the agent panes.
  // Those keep the app mounted; the TitleBar avatar shows 🔴 + in-place re-login.
  // (WO: in-app re-login + auth indicator — panes survive.)
  if ((authFlowState === AuthFlowState.UNAUTHENTICATED || authFlowState === AuthFlowState.ERROR) && !user) {
    return <LoginScreen />;
  }

  // Session died mid-use (or a re-login attempt failed while the previous user
  // object is still present). Show an in-place re-login overlay instead of
  // unmounting to LoginScreen so agent panes + context survive.
  if (authFlowState === AuthFlowState.SESSION_EXPIRED || (authFlowState === AuthFlowState.ERROR && user)) {
    return <SessionExpiredOverlay />;
  }

  // Show 2FA screen if required
  if (authFlowState === AuthFlowState.REQUIRES_2FA || authFlowState === AuthFlowState.VERIFYING_2FA) {
    return <TwoFactorScreen />;
  }

  // Show loading while settings load after auth
  if (!settingsLoaded) {
    return (
      <div className="h-full flex items-center justify-center bg-acp-bg">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-vibe-500/30 border-t-vibe-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-acp-text-secondary">Loading Agent Collaboration Platform...</p>
        </div>
      </div>
    );
  }

  // ACP-2 (WO-ACP-LIVE-TEAM-MERGE): a project with engaged_team_id == null
  // has NO standing team engaged — the fresh-project default. Its (correctly
  // empty) roster must not render as a bare empty grid; show the explicit
  // engage affordance instead (locked decision: explicit engage only). The
  // orchestrator's noTeamEngaged abort covers the same surface when the DTO
  // field hasn't hydrated yet. A non-empty roster always wins the grid.
  const showEngageCTA =
    !!activeProject &&
    pickerHasStarted &&
    agents.length === 0 &&
    (activeProject.engaged_team_id == null || noTeamEngaged?.projectId === activeProject.id);

  return (
    <div className="h-full flex flex-col bg-acp-bg text-acp-text-secondary">
      {/* Title Bar */}
      <TitleBar />

      {/* Unattended Mode Status Banner */}
      <UnattendedBanner />

      {/* Backend Connection Status Banner */}
      <BackendStatusBanner />

      {/* Team Sync Banner — DISABLED 2026-05-12 per Jon directive. The
          banner was persistently visible (and recurring after dismiss)
          even when team-sync was succeeding end-to-end and Kimi was
          spawning correctly. Suspect causes still open: stale cache
          warning field set on first sync persists across subsequent
          successful syncs, OR cloud team-sync intermittently fails
          after initial success. Re-enable once the diagnosis lands AND
          the banner is verified to actually clear when reachability
          returns. Tracked under runtime-respec follow-up. */}
      {/* <TeamSyncBanner /> */}

      {/* Main: Terminals + Panels */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Terminal Grid — or the engage-team CTA when the project has no
            standing team engaged (ACP-2; empty roster is authoritative but
            must not render as silent emptiness). */}
        <div className="flex-1 min-w-0">
          {showEngageCTA ? <EngageTeamCTA /> : <TerminalGrid agents={agents} />}
        </div>

        {/* Mail Sidebar */}
        {showSidebar && (
          <MailSidebar
            agents={agents}
            isOpen={true}
            onClose={toggleSidebar}
            activeAgent={activeAgent?.name}
          />
        )}

        {/* Kanban Board */}
        <KanbanBoard isOpen={showKanban} onClose={toggleKanban} />

        {/* Chat Panel */}
        <ChatPanel isOpen={showChat} onClose={toggleChat} />

        {/* Contractor Panel */}
        <ContractorPanel isOpen={showContractors} onClose={toggleContractors} />

        {/* Team Editor Panel */}
        <OverlayPanel isOpen={showTeamEditor} onClose={toggleTeamEditor} width="w-96" className="bg-slate-900 border-slate-700">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
            <h3 className="text-sm font-semibold text-slate-200">Team Editor</h3>
            <button
              onClick={toggleTeamEditor}
              className="text-slate-500 hover:text-slate-200 transition-colors"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-auto">
            <TeamEditor />
          </div>
        </OverlayPanel>

        {/* Document Sidebar */}
        <DocumentSidebar isOpen={showDocuments} onClose={toggleDocuments} />

        {/* Log viewer */}
        <LogViewer isOpen={showLogs} onClose={toggleLogs} />

      </div>

      {/* Team Check-in (Standup W3) — its OWN surface, decoupled from Autonomy (D5) */}
      {showStandup && <CheckinPanel onClose={toggleStandup} />}

      {/* Welcome modal — first-run tour (Task #11) */}
      {showWelcome && (
        <WelcomeModal
          onDismiss={async () => {
            setShowWelcome(false);
            try {
              await window.electronAPI.setSettings({ hasSeenWelcome: true });
            } catch (e) {
              console.warn('[App] Failed to persist hasSeenWelcome:', e);
            }
          }}
        />
      )}

      {/* Project Picker — overlay */}
      <ProjectPicker isOpen={showPicker} onClose={() => setShowPicker(false)} />

      {/* SPEC-workdir-invalid §3.4/§3.5/§3.6 — the ONE invalid-working-folder
          surface, driven by the shared projectStore.workdirInvalid slice. Both
          spawn paths converge here: the pre-flight gate (ProjectPicker) and the
          orchestrator-path IPC listener (above) write that single slice.
          Mounted at App level (not inside ProjectPicker, which unmounts when the
          picker closes) so an orchestrator failure surfaces even with no picker
          open. Rendered AFTER the picker so it stacks above it on the gate path. */}
      {workdirInvalid && (
        <WorkdirCorrection
          projectId={workdirInvalid.projectId}
          projectName={workdirInvalid.projectName}
          badPath={workdirInvalid.badPath}
          onResolved={async () => {
            // Path fixed + persisted (store updated activeProject.repo_path).
            // Re-run the spawn fan-out: reseedLifecycle re-seeds the orchestrator
            // with the corrected path. Serves BOTH entry paths — the pre-flight
            // gate's first spawn AND the orchestrator path's re-spawn after fail.
            await window.electronAPI.reseedLifecycle();
            const store = useProjectStore.getState();
            store.clearWorkdirInvalid();
            store.markPickerStarted();
            setShowPicker(false);
          }}
          onPickAnother={() => {
            // Nothing spawned, nothing persisted — drop back to the picker list.
            useProjectStore.getState().clearWorkdirInvalid();
            setShowPicker(true);
          }}
        />
      )}

      {/* SPEC-team-runtime §3.2/§4 — reconcile-on-switch confirm (kill live
          work to conform a mixed team to the team runtime) + §3.3 runtime-not-set
          block surface (active project with no team runtime → BLOCK, no silent
          default). Both store-driven, mounted at App level like WorkdirCorrection. */}
      <RuntimeReconcileDialog />
      <RuntimeNotSet />

      {/* Project Settings — drawer (read-only Phase 1) */}
      <ProjectSettingsPanel isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {/* Emergency Stop — floating button when unattended active */}
      <EmergencyStopButton />

      {/* Team Builder Modal — Specialist Library overlay */}
      <TeamBuilderModal isOpen={showTeamBuilder} onClose={() => toggleTeamBuilder()} />

      {/* Document Viewer Modal — fixed overlay */}
      <DocumentModal />

      {/* Terminal Replay v1 panel */}
      <ReplayPanel />
    </div>
  );
}
