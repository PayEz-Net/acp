import { create } from 'zustand';
import { Terminal } from 'xterm';
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

  // Agents
  agents: AgentState[];
  activeAgentId: string | null;

  // Terminal refs for SSE message injection
  terminalRefs: Map<string, Terminal>;

  // ACP backend
  backendAvailable: boolean;

  // API settings
  vibeApiUrl: string;

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
  setActiveAgent: (id: string | null) => void;
  setAgents: (agents: AgentConfig[]) => void;
  updateAgentStatus: (id: string, status: AgentState['status']) => void;
  setAgentTerminalId: (agentId: string, terminalId: string) => void;
  setSettings: (settings: AppSettings) => void;
  registerTerminal: (agentName: string, terminal: Terminal) => void;
  unregisterTerminal: (agentName: string) => void;
  injectMessage: (agentName: string, message: string) => void;
  setBackendAvailable: (available: boolean) => void;
  setAutonomyEnabled: (enabled: boolean) => void;
  setAutonomyStatus: (status: AutonomyStatus | null) => void;
  toggleAutonomyPanel: () => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  // Initial state
  layout: 'grid',
  focusAgent: 'BAPert',
  showSidebar: false,
  showMail: true,
  showKanban: false,
  showStandup: false,
  showContractors: false,
  showChat: false,
  agents: [],
  activeAgentId: null,
  terminalRefs: new Map(),
  backendAvailable: false,
  vibeApiUrl: 'https://api.idealvibe.online',
  autonomyEnabled: false,
  autonomyStatus: null,
  autonomyPanelOpen: false,

  // Actions
  setLayout: (layout) => set({ layout }),
  setFocusAgent: (focusAgent) => set({ focusAgent }),
  toggleSidebar: () => set((s) => ({ showSidebar: !s.showSidebar })),
  toggleMail: () => set((s) => ({ showMail: !s.showMail })),
  toggleKanban: () => set((s) => ({ showKanban: !s.showKanban })),
  toggleStandup: () => set((s) => ({ showStandup: !s.showStandup })),
  toggleContractors: () => set((s) => ({ showContractors: !s.showContractors })),
  toggleChat: () => set((s) => ({ showChat: !s.showChat })),
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

  setSettings: (settings) => set({
    layout: settings.layout,
    focusAgent: settings.focusAgent,
    showSidebar: settings.showSidebar,
    vibeApiUrl: settings.vibeApiUrl ?? 'https://api.idealvibe.online',
  }),

  registerTerminal: (agentName, terminal) => {
    const refs = new Map(get().terminalRefs);
    refs.set(agentName, terminal);
    set({ terminalRefs: refs });
  },

  unregisterTerminal: (agentName) => {
    const refs = new Map(get().terminalRefs);
    refs.delete(agentName);
    set({ terminalRefs: refs });
  },

  injectMessage: (agentName, message) => {
    const terminal = get().terminalRefs.get(agentName);
    if (terminal) {
      terminal.write(message);
    }
  },

  setBackendAvailable: (available) => set({ backendAvailable: available }),
  setAutonomyEnabled: (enabled) => set({ autonomyEnabled: enabled }),
  setAutonomyStatus: (status) => set({ autonomyStatus: status, autonomyEnabled: status?.enabled ?? false }),
  toggleAutonomyPanel: () => set((s) => ({ autonomyPanelOpen: !s.autonomyPanelOpen })),
}));
