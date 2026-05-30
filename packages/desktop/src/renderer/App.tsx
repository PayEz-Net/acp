import { useEffect, useState } from 'react';
import { MailSidebar } from './components/Mail';
import { LoginScreen, TwoFactorScreen } from './components/Auth';
import { SplashScreen } from './components/SplashScreen';
import { TerminalGrid } from './components/Terminal/TerminalGrid';
import { TitleBar } from './components/Layout/TitleBar';
// import { TeamSyncBanner } from './components/Layout/TeamSyncBanner'; // disabled — see mount-site comment below
import { KanbanBoard } from './components/Kanban/KanbanBoard';
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
import { useAppStore } from './stores/appStore';
import { useDocumentStore } from './stores/documentStore';
import { useProjectStore } from './stores/projectStore';
import { useAuthStore, AuthFlowState } from './stores/authStore';
import { useTeamStore } from './stores/teamStore';
import { useAcpSse } from './hooks/useAcpSse';
import { useTeamPoll } from './hooks/useTeamPoll';
import { agentReconcile } from './lib/agentReconcile';

// Spec §4.4 — local fallback fires only when localhost acp-stable-api is
// unreachable. Backend `team.ts` owns the same BAPert+QAPert seed when
// cloud is down + cache cold (Decision 3a). The two literals must agree.
const DEFAULT_AGENTS = [
  { id: '1', name: 'BAPert', displayName: 'BAPert', workDir: '', autoStart: false, position: 'top-left' as const, color: '#8b5cf6' },
  { id: '2', name: 'QAPert', displayName: 'QAPert', workDir: '', autoStart: false, position: 'top-right' as const, color: '#f59e0b' },
];

export default function App() {
  const { agents, showSidebar, toggleSidebar, showKanban, toggleKanban, showChat, toggleChat, showStandup, toggleStandup, showContractors, toggleContractors, showTeamEditor, toggleTeamEditor, activeAgentId, setAgents, setSettings } = useAppStore();
  const { showDocuments, toggleDocuments } = useDocumentStore();
  const { showPicker, setShowPicker, showSettings, setShowSettings, fetchActiveProject, fetchProjects, activeProject } = useProjectStore();
  const { showTeamBuilder, toggleTeamBuilder } = useAppStore();
  const { authFlowState, isLoading: authLoading, loadStatus } = useAuthStore();
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
        setSettings({ layout: 'grid', focusAgent: 'BAPert', showSidebar: true, windowBounds: { x: 100, y: 100, width: 1200, height: 800 }, agents: DEFAULT_AGENTS, mailPollInterval: 30000, theme: 'dark', sidebarWidth: 320, vibeApiUrl: 'https://api.idealvibe.online', environment: 'prod' });
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
      useAuthStore.getState().logout();
    });

    return () => {
      unsubscribe();
      unsubscribeSessionDead();
    };
  }, []);

  // Bind panes to spawn-orchestrator-spawned terminals. The orchestrator
  // spawns PTYs in main and the renderer never called pty:spawn, so the
  // agent has no terminalId and the pane sits idle ("Press ▷") while a
  // live Claude session runs behind it. Main now emits pty:spawned with
  // agentName→terminalId; map it onto the agent so TerminalPane's
  // terminalId-gated effects attach the xterm to the running PTY.
  useEffect(() => {
    const unsub = window.electronAPI.onAgentSpawned(({ agentName, terminalId }) => {
      const st = useAppStore.getState();
      const agent = st.agents.find((a) => a.name === agentName);
      if (agent && agent.terminalId !== terminalId) {
        console.log(`[App] orchestrator spawned ${agentName} → terminal=${terminalId}; binding pane`);
        st.setAgentTerminalId(agent.id, terminalId);
      }
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
  useEffect(() => {
    if (!isAuthenticated) return;
    if (!settingsLoaded) return;
    fetchActiveProject();
    fetchProjects();
  }, [isAuthenticated, settingsLoaded, fetchActiveProject, fetchProjects]);

  // Phase 5 — sync the team for the active project, then reconcile against
  // local UI prefs. Spec §4.3. Re-runs on project switch via the dependency
  // on `activeProject?.id`. The reconcile output is what the grid renders;
  // we also persist it back to electron-store so layout/color survive boots.
  useEffect(() => {
    if (!settingsLoaded || !activeProject) return;
    let cancelled = false;
    (async () => {
      await useTeamStore.getState().syncTeam(activeProject.id);
      if (cancelled) return;
      const cloud = useTeamStore.getState().cloudAgents;
      if (cloud.length === 0) {
        // Spec AC-9: empty cloud roster is authoritative — render empty
        // grid; do NOT fall through to DEFAULT_AGENTS. Banner UX (if
        // source !== 'cloud') still surfaces via TeamSyncBanner.
        useAppStore.getState().setAgents([]);
        return;
      }
      const localPrefs = useAppStore.getState().settings.agents ?? [];
      const reconciled = agentReconcile(cloud, localPrefs);
      useAppStore.getState().setAgents(reconciled);
      window.electronAPI.setSettings({ agents: reconciled });
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsLoaded, activeProject?.id]);

  // Phase 1b: Single centralized SSE connection through acp-api
  useAcpSse();

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
      <div className="h-full flex items-center justify-center bg-slate-900">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-vibe-500/30 border-t-vibe-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-400">Loading...</p>
        </div>
      </div>
    );
  }

  // Show login screen if not authenticated
  if (authFlowState === AuthFlowState.UNAUTHENTICATED || authFlowState === AuthFlowState.ERROR) {
    return <LoginScreen />;
  }

  // Show 2FA screen if required
  if (authFlowState === AuthFlowState.REQUIRES_2FA || authFlowState === AuthFlowState.VERIFYING_2FA) {
    return <TwoFactorScreen />;
  }

  // Show loading while settings load after auth
  if (!settingsLoaded) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-900">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-vibe-500/30 border-t-vibe-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-400">Loading Agent Collaboration Platform...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#0B1221] text-slate-300">
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
      <div className="flex-1 min-h-0 flex overflow-hidden p-2 gap-2">
        {/* Terminal Grid */}
        <div className="flex-1 min-w-0">
          <TerminalGrid agents={agents} />
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
        {showTeamEditor && (
          <div className="w-96 min-w-[24rem] max-w-full bg-slate-900 border border-slate-800 rounded-lg overflow-hidden flex flex-col">
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
          </div>
        )}

        {/* Document Sidebar */}
        <DocumentSidebar isOpen={showDocuments} onClose={toggleDocuments} />

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

      {/* Project Settings — drawer (read-only Phase 1) */}
      <ProjectSettingsPanel isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {/* Emergency Stop — floating button when unattended active */}
      <EmergencyStopButton />

      {/* Team Builder Modal — Specialist Library overlay */}
      <TeamBuilderModal isOpen={showTeamBuilder} onClose={() => toggleTeamBuilder()} />

      {/* Document Viewer Modal — fixed overlay */}
      <DocumentModal />
    </div>
  );
}
