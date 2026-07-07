import { create } from 'zustand';
import { AgentConfig, AgentState, AppSettings, LayoutMode, AutonomyStatus } from '@shared/types';

interface AppStore {
  // Layout
  layout: LayoutMode;
  focusAgent: string;
  showSidebar: boolean;
  showMail: boolean;
  showKanban: boolean;
  showStandup: boolean;
  showContractors: boolean;
  showChat: boolean;
  showTeamEditor: boolean;
  showTeamBuilder: boolean;

  // Agents
  agents: AgentState[];
  activeAgentId: string | null;

  // ACP backend
  backendAvailable: boolean;


  // Full settings object for UI
  settings: AppSettings;

  // Autonomy state
  autonomyEnabled: boolean;
  autonomyStatus: AutonomyStatus | null;
  autonomyPanelOpen: boolean;

  // Actions
  setLayout: (layout: LayoutMode) => void;
  setFocusAgent: (name: string) => void;
  toggleSidebar: () => void;
  toggleMail: () => void;
  toggleKanban: () => void;
  toggleStandup: () => void;
  toggleContractors: () => void;
  toggleChat: () => void;
  toggleTeamEditor: () => void;
  toggleTeamBuilder: () => void;
  setActiveAgent: (id: string | null) => void;
  setAgents: (agents: AgentConfig[]) => void;
  updateAgentStatus: (id: string, status: AgentState['status']) => void;
  setAgentTerminalId: (agentId: string, terminalId: string) => void;
  setSettings: (settings: AppSettings) => void;
  setAgentProvider: (provider: AgentConfig['provider']) => void;
  setBackendAvailable: (available: boolean) => void;
  setAutonomyEnabled: (enabled: boolean) => void;
  setAutonomyStatus: (status: AutonomyStatus | null) => void;
  toggleAutonomyPanel: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  // Initial state
  layout: 'grid',
  focusAgent: 'BAPert',
  showSidebar: false,
  showMail: true,
  showKanban: false,
  showStandup: false,
  showContractors: false,
  showChat: false,
  showTeamEditor: false,
  showTeamBuilder: false,
  agents: [],
  activeAgentId: null,
  backendAvailable: false,
  autonomyEnabled: false,
  autonomyStatus: null,
  autonomyPanelOpen: false,
  settings: {} as AppSettings,

  // Actions
  setLayout: (layout) => set({ layout }),
  setFocusAgent: (focusAgent) => set({ focusAgent }),
  toggleSidebar: () => set((s) => ({ showSidebar: !s.showSidebar })),
  toggleMail: () => set((s) => ({ showMail: !s.showMail })),
  toggleKanban: () => set((s) => ({ showKanban: !s.showKanban })),
  toggleStandup: () => set((s) => ({ showStandup: !s.showStandup })),
  toggleContractors: () => set((s) => ({ showContractors: !s.showContractors })),
  toggleChat: () => set((s) => ({ showChat: !s.showChat })),
  toggleTeamEditor: () => set((s) => ({ showTeamEditor: !s.showTeamEditor })),
  toggleTeamBuilder: () => set((s) => ({ showTeamBuilder: !s.showTeamBuilder })),
  setActiveAgent: (activeAgentId) => set({ activeAgentId }),

  setAgents: (configs) => set({
    agents: configs.map((config) => ({
      ...config,
      status: 'offline' as const,
    })),
  }),

  updateAgentStatus: (id, status) => set((state) => ({
    agents: state.agents.map((a) =>
      a.id === id ? { ...a, status } : a
    ),
  })),

  setAgentTerminalId: (agentId, terminalId) => set((state) => ({
    agents: state.agents.map((a) =>
      a.id === agentId ? { ...a, terminalId } : a
    ),
  })),

  setAgentProvider: (provider) => set((state) => {
    const updatedAgents = state.agents.map((a) => ({ ...a, provider }));
    const updatedSettings = {
      ...state.settings,
      agentProvider: provider,
      agents: state.settings.agents?.map((a) => ({ ...a, provider })),
    };
    return { agents: updatedAgents, settings: updatedSettings };
  }),

  setSettings: (settings) => set({
    layout: settings.layout,
    focusAgent: settings.focusAgent,
    showSidebar: settings.showSidebar,
    settings,
  }),

  setBackendAvailable: (available) => set({ backendAvailable: available }),
  setAutonomyEnabled: (enabled) => set({ autonomyEnabled: enabled }),
  setAutonomyStatus: (status) => set({ autonomyStatus: status, autonomyEnabled: status?.enabled ?? false }),
  toggleAutonomyPanel: () => set((s) => ({ autonomyPanelOpen: !s.autonomyPanelOpen })),
}));
