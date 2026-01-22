import { useEffect, useState } from 'react';
import { MailSidebar } from './components/Mail';
import { KanbanSidebar } from './components/Kanban';
import { StandupSidebar } from './components/Standup';
import { DocumentSidebar, DocumentModal } from './components/Documents';
import { AutonomyPanel, EmergencyStopButton } from './components/Autonomy';
import { LoginScreen, TwoFactorScreen } from './components/Auth';
import { SplashScreen } from './components/SplashScreen';
import { ACPCanvas, ACPHeader, AgentDetailPanel, EventLog } from './components/ACP';
import { useAppStore } from './stores/appStore';
import { useAuthStore, AuthFlowState } from './stores/authStore';
import { useDocumentStore } from './stores/documentStore';
import { useACPStore } from './stores/acpStore';

// Default agents for demo/browser mode
const DEFAULT_AGENTS = [
  { id: '1', name: 'BAPert', displayName: 'BAPert', workDir: 'E:\\Repos', autoStart: false, position: 'top-right' as const, color: '#8b5cf6' },
  { id: '2', name: 'DotNetPert', displayName: 'DotNetPert', workDir: 'E:\\Repos', autoStart: false, position: 'bottom-left' as const, color: '#06b6d4' },
  { id: '3', name: 'NextPert', displayName: 'NextPert', workDir: 'E:\\Repos', autoStart: false, position: 'top-left' as const, color: '#22c55e' },
  { id: '4', name: 'QAPert', displayName: 'QAPert', workDir: 'E:\\Repos', autoStart: false, position: 'bottom-right' as const, color: '#f59e0b' },
];

export default function App() {
  const { agents, showMail, showKanban, showStandup, toggleMail, toggleKanban, toggleStandup, activeAgentId, setAgents, setSettings } = useAppStore();
  const { authFlowState, isLoading: authLoading, loadStatus } = useAuthStore();
  const { showDocuments, toggleDocuments } = useDocumentStore();
  const { agents: acpAgents, selectedAgentId, selectAgent, projectProgress } = useACPStore();
  const isAuthenticated = authFlowState === AuthFlowState.AUTHENTICATED;
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [showSplash, setShowSplash] = useState(true);

  // Find active agent name for mail composition
  const activeAgent = agents.find((a) => a.id === activeAgentId);

  // Find selected ACP agent for detail panel
  const selectedAcpAgent = acpAgents.find((a) => a.id === selectedAgentId);

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
        setAgents(settings.agents);
      } catch (err) {
        console.error('Failed to load settings, using defaults:', err);
        setAgents(DEFAULT_AGENTS);
        setSettings({ layout: 'grid', focusAgent: 'BAPert', showSidebar: true, windowBounds: { x: 100, y: 100, width: 1200, height: 800 }, agents: DEFAULT_AGENTS, mailPollInterval: 30000, theme: 'dark', sidebarWidth: 320, mailPushEnabled: true, mailPushUrl: 'https://api.idealvibe.online' });
      } finally {
        setSettingsLoaded(true);
      }
    }
    loadSettings();
  }, [isAuthenticated, settingsLoaded, setSettings, setAgents]);

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
      {/* ACP Header */}
      <ACPHeader
        onToggleMail={toggleMail}
        onToggleKanban={toggleKanban}
        showMail={showMail}
        showKanban={showKanban}
      />

      {/* Progress Bar */}
      <div className="h-1.5 w-full bg-slate-900/50 relative z-40 border-b border-slate-800/50">
        <div
          className="h-full bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.5)] transition-all duration-1000"
          style={{ width: `${projectProgress}%` }}
        />
        <div className="absolute right-6 -bottom-5 text-[9px] font-black font-mono text-cyan-500 uppercase tracking-widest z-50 bg-[#0B1221] px-2 rounded-full border border-slate-800">
          {projectProgress}% Complete
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* ACP Canvas (Party Room) */}
        <ACPCanvas />

        {/* Agent Detail Panel (when agent selected) */}
        {selectedAcpAgent && (
          <AgentDetailPanel
            agent={selectedAcpAgent}
            onClose={() => selectAgent(null)}
          />
        )}

        {/* Mail Sidebar */}
        {showMail && (
          <MailSidebar
            agents={agents}
            isOpen={true}
            onClose={toggleMail}
            activeAgent={activeAgent?.name}
          />
        )}

        {/* Kanban Sidebar */}
        {showKanban && (
          <KanbanSidebar
            isOpen={true}
            onClose={toggleKanban}
            agents={agents.map((a) => ({ id: a.id, name: a.name }))}
          />
        )}

        {/* Standup Sidebar */}
        {showStandup && (
          <StandupSidebar isOpen={true} onClose={toggleStandup} />
        )}

        {/* Documents Sidebar */}
        {showDocuments && (
          <DocumentSidebar isOpen={true} onClose={toggleDocuments} />
        )}
      </div>

      {/* Event Log Footer */}
      <EventLog />

      {/* Document Viewer Modal */}
      <DocumentModal />

      {/* Autonomy Panel (modal) */}
      <AutonomyPanel />

      {/* Emergency Stop Button (floating) */}
      <EmergencyStopButton />
    </div>
  );
}
