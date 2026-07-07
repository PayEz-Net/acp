import { create } from 'zustand';

export interface AgentStatus {
  /** Context window usage percentage (0-100). */
  contextUsage?: number;
  /** Tokens used in the current session. */
  tokenUsed?: number;
  /** Token context window limit. */
  tokenMax?: number;
  /** Current working directory reported by the provider. */
  cwd?: string;
  /** Provider/model identifier (e.g. 'K2.7 Code', 'claude-sonnet-4-6'). */
  model?: string;
  /** Provider name (kimi, claude, codex). */
  provider?: string;
  /** Composing / processing state with duration and token count. */
  composing?: {
    duration: string;
    tokens: number;
  } | null;
  /** Background tasks reported by backend (future). */
  backgroundTasks?: string[];
  /** Last time any field was updated. */
  lastSeenAt?: string;
}

interface AgentStatusState {
  statuses: Record<string, AgentStatus>;
  setStatus: (agentName: string, update: Partial<AgentStatus>) => void;
  getStatus: (agentName: string) => AgentStatus;
  clear: (agentName?: string) => void;
}

function emptyStatus(): AgentStatus {
  return {};
}

export const useAgentStatusStore = create<AgentStatusState>((set, get) => ({
  statuses: {},

  setStatus: (agentName, update) => {
    if (!agentName) return;
    set((state) => {
      const current = state.statuses[agentName] ?? emptyStatus();
      return {
        statuses: {
          ...state.statuses,
          [agentName]: {
            ...current,
            ...update,
            lastSeenAt: new Date().toISOString(),
          },
        },
      };
    });
  },

  getStatus: (agentName) => {
    return get().statuses[agentName] ?? emptyStatus();
  },

  clear: (agentName) => {
    if (!agentName) {
      set({ statuses: {} });
      return;
    }
    set((state) => {
      const next = { ...state.statuses };
      delete next[agentName];
      return { statuses: next };
    });
  },
}));
