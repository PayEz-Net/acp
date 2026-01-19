import { create } from 'zustand';
import { AgentConfig, AgentState, AppSettings, LayoutMode } from '@shared/types';

interface AppStore {
  // Layout
  layout: LayoutMode;
  focusAgent: string;
  showSidebar: boolean;
  showMail: boolean;
  showKanban: boolean;

  // Agents
  agents: AgentState[];
  activeAgentId: string | null;

  // Actions
  setLayout: (layout: LayoutMode) => void;
  setFocusAgent: (name: string) => void;
  toggleSidebar: () => void;
  toggleMail: () => void;
  toggleKanban: () => void;
  setActiveAgent: (id: string | null) => void;
  setAgents: (agents: AgentConfig[]) => void;
  updateAgentStatus: (id: string, status: AgentState['status']) => void;
  setAgentTerminalId: (agentId: string, terminalId: string) => void;
  setSettings: (settings: AppSettings) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  // Initial state
  layout: 'grid',
  focusAgent: 'BAPert',
  showSidebar: false,
  showMail: true,
  showKanban: false,
  agents: [],
  activeAgentId: null,

  // Actions
  setLayout: (layout) => set({ layout }),
  setFocusAgent: (focusAgent) => set({ focusAgent }),
  toggleSidebar: () => set((s) => ({ showSidebar: !s.showSidebar })),
  toggleMail: () => set((s) => ({ showMail: !s.showMail })),
  toggleKanban: () => set((s) => ({ showKanban: !s.showKanban })),
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
  }),
}));
