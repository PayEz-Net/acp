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

  // Agents
  agents: AgentState[];
  activeAgentId: string | null;

  // Terminal refs for SSE message injection
  terminalRefs: Map<string, Terminal>;

  // Mail push settings
  mailPushEnabled: boolean;
  mailPushUrl: string;

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
  setActiveAgent: (id: string | null) => void;
  setAgents: (agents: AgentConfig[]) => void;
  updateAgentStatus: (id: string, status: AgentState['status']) => void;
  setAgentTerminalId: (agentId: string, terminalId: string) => void;
  setSettings: (settings: AppSettings) => void;
  registerTerminal: (agentName: string, terminal: Terminal) => void;
  unregisterTerminal: (agentName: string) => void;
  injectMessage: (agentName: string, message: string) => void;
  toggleMailPush: () => void;
  setMailPushEnabled: (enabled: boolean) => void;
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
  agents: [],
  activeAgentId: null,
  terminalRefs: new Map(),
  mailPushEnabled: true,
  mailPushUrl: 'https://api.idealvibe.online',
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
    mailPushEnabled: settings.mailPushEnabled ?? true,
    mailPushUrl: settings.mailPushUrl ?? 'https://api.idealvibe.online',
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

  toggleMailPush: () => set((s) => ({ mailPushEnabled: !s.mailPushEnabled })),
  setMailPushEnabled: (enabled) => set({ mailPushEnabled: enabled }),
  setAutonomyEnabled: (enabled) => set({ autonomyEnabled: enabled }),
  setAutonomyStatus: (status) => set({ autonomyStatus: status, autonomyEnabled: status?.enabled ?? false }),
  toggleAutonomyPanel: () => set((s) => ({ autonomyPanelOpen: !s.autonomyPanelOpen })),
}));
