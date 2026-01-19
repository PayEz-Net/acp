import { useEffect, useState } from 'react';
import { TitleBar } from './components/Layout/TitleBar';
import { TerminalGrid } from './components/Terminal/TerminalGrid';
import { MailSidebar } from './components/Mail';
import { useAppStore } from './stores/appStore';

export default function App() {
  const { agents, showSidebar, toggleSidebar, activeAgentId, setAgents, setSettings } = useAppStore();
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
        console.error('Failed to load settings:', err);
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

        {/* Mail Sidebar */}
        <MailSidebar
          agents={agents}
          isOpen={showSidebar}
          onClose={toggleSidebar}
          activeAgent={activeAgent?.name}
        />
      </div>
    </div>
  );
}
