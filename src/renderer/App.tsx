import { useEffect, useState } from 'react';
import { TitleBar } from './components/Layout/TitleBar';
import { TerminalGrid } from './components/Terminal/TerminalGrid';
import { MailSidebar } from './components/Mail';
import { KanbanSidebar } from './components/Kanban';
import { useAppStore } from './stores/appStore';

// Default agents for demo/browser mode
const DEFAULT_AGENTS = [
  { id: '1', name: 'BAPert', displayName: 'BAPert', workDir: 'E:\\Repos', autoStart: false, position: 'top-right' as const, color: '#8b5cf6' },
  { id: '2', name: 'DotNetPert', displayName: 'DotNetPert', workDir: 'E:\\Repos', autoStart: false, position: 'bottom-left' as const, color: '#06b6d4' },
  { id: '3', name: 'NextPert', displayName: 'NextPert', workDir: 'E:\\Repos', autoStart: false, position: 'top-left' as const, color: '#22c55e' },
  { id: '4', name: 'QAPert', displayName: 'QAPert', workDir: 'E:\\Repos', autoStart: false, position: 'bottom-right' as const, color: '#f59e0b' },
];

export default function App() {
  const { agents, showSidebar, toggleSidebar, sidebarTab, setSidebarTab, activeAgentId, setAgents, setSettings } = useAppStore();
  const [isLoading, setIsLoading] = useState(true);

  // Find active agent name for mail composition
  const activeAgent = agents.find((a) => a.id === activeAgentId);

  useEffect(() => {
    // Load settings on startup
    async function loadSettings() {
      try {
        const settings = await window.electronAPI.getSettings();
        setSettings(settings);
        setAgents(settings.agents);
      } catch (err) {
        console.error('Failed to load settings, using defaults:', err);
        // Use default agents in browser mode
        setAgents(DEFAULT_AGENTS);
        setSettings({ layout: 'grid', focusAgent: 'BAPert', showSidebar: true, windowBounds: { x: 100, y: 100, width: 1200, height: 800 }, agents: DEFAULT_AGENTS, mailPollInterval: 30000, theme: 'dark', sidebarWidth: 320 });
      } finally {
        setIsLoading(false);
      }
    }
    loadSettings();
  }, [setSettings, setAgents]);

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-900">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-vibe-500/30 border-t-vibe-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-400">Loading Vibe Agents Harness...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-slate-900">
      <TitleBar />
      <div className="flex-1 min-h-0 flex">
        {/* Terminal Grid */}
        <main className="flex-1 min-w-0 p-2">
          <TerminalGrid agents={agents} />
        </main>

        {/* Sidebars */}
        {showSidebar && (
          <div className="flex h-full">
            {/* Tab Switcher */}
            <div className="w-10 bg-[#0a1929] border-l border-[#2d4a6b] flex flex-col items-center py-2 gap-1">
              <button
                onClick={() => setSidebarTab('mail')}
                className={`p-2 rounded transition-colors ${
                  sidebarTab === 'mail'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:bg-[#2d4a6b]'
                }`}
                title="Mail"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </button>
              <button
                onClick={() => setSidebarTab('kanban')}
                className={`p-2 rounded transition-colors ${
                  sidebarTab === 'kanban'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:bg-[#2d4a6b]'
                }`}
                title="Kanban"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </button>
            </div>

            {/* Active Sidebar */}
            {sidebarTab === 'mail' ? (
              <MailSidebar
                agents={agents}
                isOpen={true}
                onClose={toggleSidebar}
                activeAgent={activeAgent?.name}
              />
            ) : (
              <KanbanSidebar
                isOpen={true}
                onClose={toggleSidebar}
                agents={agents.map((a) => ({ id: a.id, name: a.name }))}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
