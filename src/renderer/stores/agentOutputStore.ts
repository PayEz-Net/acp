import { create } from 'zustand';

export interface AgentOutputLine {
  agent: string;
  terminal_id?: string;
  provider?: string;
  line: string;
  ts: string;
  /** Accumulated thinking content associated with this line (the answer). */
  thinking?: string;
  /** When true, this line is a live thinking placeholder that should be replaced by the final answer. */
  thinkingLive?: boolean;
}

interface AgentOutputStore {
  lines: AgentOutputLine[];
  maxLines: number;
  paused: boolean;
  selectedAgent: string | null;

  addLine: (line: AgentOutputLine) => void;
  addLines: (lines: AgentOutputLine[]) => void;
  clear: (agentName?: string) => void;
  setPaused: (paused: boolean) => void;
  setSelectedAgent: (agent: string | null) => void;
  setMaxLines: (max: number) => void;
}

const MAX_DEFAULT = 1000;

function isLiveThinking(line: AgentOutputLine): boolean {
  return !!line.thinkingLive;
}

export const useAgentOutputStore = create<AgentOutputStore>((set) => ({
  lines: [],
  maxLines: MAX_DEFAULT,
  paused: false,
  selectedAgent: null,

  addLine: (line) => {
    if (!line?.line && !line?.thinking) return;
    set((state) => {
      const next = [...state.lines];
      const lastIdx = next.length - 1;
      const last = next[lastIdx];
      // Replace the previous live-thinking placeholder for the same agent
      // rather than appending a new one, so the UI shows a single updating block.
      if (isLiveThinking(line) && last && last.agent === line.agent && isLiveThinking(last)) {
        next[lastIdx] = line;
      } else if (!isLiveThinking(line) && last && last.agent === line.agent && isLiveThinking(last)) {
        // Final answer line replaces the live-thinking placeholder.
        next[lastIdx] = line;
      } else {
        next.push(line);
      }
      if (next.length > state.maxLines) {
        next.splice(0, next.length - state.maxLines);
      }
      return { lines: next };
    });
  },

  addLines: (lines) => {
    const valid = lines.filter((l) => l?.line || l?.thinking);
    if (valid.length === 0) return;
    set((state) => {
      const next = [...state.lines];
      for (const line of valid) {
        const lastIdx = next.length - 1;
        const last = next[lastIdx];
        if (isLiveThinking(line) && last && last.agent === line.agent && isLiveThinking(last)) {
          next[lastIdx] = line;
        } else if (!isLiveThinking(line) && last && last.agent === line.agent && isLiveThinking(last)) {
          next[lastIdx] = line;
        } else {
          next.push(line);
        }
      }
      if (next.length > state.maxLines) {
        next.splice(0, next.length - state.maxLines);
      }
      return { lines: next };
    });
  },

  clear: (agentName) => {
    if (!agentName) {
      set({ lines: [] });
      return;
    }
    set((state) => ({
      lines: state.lines.filter((l) => l.agent !== agentName),
    }));
  },

  setPaused: (paused) => set({ paused }),
  setSelectedAgent: (agent) => set({ selectedAgent: agent }),
  setMaxLines: (max) => set({ maxLines: Math.max(100, Math.min(5000, max)) }),
}));
