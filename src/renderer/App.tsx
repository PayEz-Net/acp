import { useEffect, useState } from 'react';
import { MailSidebar } from './components/Mail';
import { LoginScreen, TwoFactorScreen } from './components/Auth';
import { SplashScreen } from './components/SplashScreen';
import { TerminalGrid } from './components/Terminal/TerminalGrid';
import { useAppStore } from './stores/appStore';
import { useAuthStore, AuthFlowState } from './stores/authStore';
import { useAcpSse } from './hooks/useAcpSse';
import { Mail, MailOpen } from 'lucide-react';

// The team
const DEFAULT_AGENTS = [
  { id: '1', name: 'BAPert', displayName: 'BAPert', workDir: 'E:\\Repos', autoStart: false, position: 'top-left' as const, color: '#8b5cf6' },
  { id: '2', name: 'Aurum', displayName: 'Aurum', workDir: 'E:\\Repos', autoStart: false, position: 'top-right' as const, color: '#f97316' },
  { id: '3', name: 'DotNetPert', displayName: 'DotNetPert', workDir: 'E:\\Repos', autoStart: false, position: 'bottom-left' as const, color: '#06b6d4' },
  { id: '4', name: 'NextPert', displayName: 'NextPert', workDir: 'E:\\Repos', autoStart: false, position: 'bottom-right' as const, color: '#22c55e' },
  { id: '5', name: 'QAPert', displayName: 'QAPert', workDir: 'E:\\Repos', autoStart: false, position: 'bottom-right' as const, color: '#f59e0b' },
];

export default function App() {
  const { agents, showMail, toggleMail, activeAgentId, setAgents, setSettings } = useAppStore();
  const { authFlowState, isLoading: authLoading, loadStatus } = useAuthStore();
  const isAuthenticated = authFlowState === AuthFlowState.AUTHENTICATED;
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [showSplash, setShowSplash] = useState(true);

  // Find active agent name for mail composition
  const activeAgent = agents.find((a) => a.id === activeAgentId);

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
        setSettings({ layout: 'grid', focusAgent: 'BAPert', showSidebar: true, windowBounds: { x: 100, y: 100, width: 1200, height: 800 }, agents: DEFAULT_AGENTS, mailPollInterval: 30000, theme: 'dark', sidebarWidth: 320, vibeApiUrl: 'https://api.idealvibe.online', environment: 'prod' });
      } finally {
        setSettingsLoaded(true);
      }
    }
    loadSettings();
  }, [isAuthenticated, settingsLoaded, setSettings, setAgents]);

  // Phase 1b: Single centralized SSE connection through acp-api
  useAcpSse();

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
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-2 border-b border-slate-800/50 bg-[#0B1221]/80 backdrop-blur-sm z-50">
        <h1 className="text-lg font-bold text-white tracking-tight">
          Agent Collaboration Platform
        </h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">{agents.length} agents</span>
          <button
            onClick={toggleMail}
            className={`p-2 rounded-lg transition-colors ${
              showMail
                ? 'bg-violet-600 text-white'
                : 'text-slate-400 hover:bg-slate-800 hover:text-white'
            }`}
            title={showMail ? 'Hide Mail' : 'Show Mail'}
          >
            {showMail ? <MailOpen className="w-5 h-5" /> : <Mail className="w-5 h-5" />}
          </button>
        </div>
      </header>

      {/* Main: Terminals + Mail */}
      <div className="flex-1 min-h-0 flex overflow-hidden p-2 gap-2">
        {/* Terminal Grid */}
        <div className="flex-1 min-w-0">
          <TerminalGrid agents={agents} />
        </div>

        {/* Mail Stream */}
        {showMail && (
          <MailSidebar
            agents={agents}
            isOpen={true}
            onClose={toggleMail}
            activeAgent={activeAgent?.name}
          />
        )}
      </div>
    </div>
  );
}
