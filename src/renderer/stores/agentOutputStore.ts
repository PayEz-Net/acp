import { create } from 'zustand';

export type OutputSource = 'agent' | 'user' | 'info';

let nextLineId = 1;

export function generateAgentOutputLineId(): string {
  return `line-${nextLineId++}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface AgentOutputLine {
  /** Stable unique identifier for this line. Used as a React key. */
  id: string;
  agent: string;
  terminal_id?: string;
  provider?: string;
  line: string;
  ts: string;
  /** Who/what produced this line: agent output, user input, or info/system. */
  source?: OutputSource;
  /** Accumulated thinking content associated with this line (the answer). */
  thinking?: string;
  /** When true, this line is a live thinking placeholder that should be replaced by the final answer. */
  thinkingLive?: boolean;
  /** Structured code-change payload when this line represents an edit block. */
  codeChange?: import('../lib/terminalStream').CodeChangeLine;
}

interface AgentOutputStore {
  lines: AgentOutputLine[];
  maxLines: number;
  paused: boolean;
  selectedAgent: string | null;

  addLine: (line: Omit<AgentOutputLine, 'id'>) => void;
  addLines: (lines: Omit<AgentOutputLine, 'id'>[]) => void;
  clear: (agentName?: string) => void;
  setPaused: (paused: boolean) => void;
  setSelectedAgent: (agent: string | null) => void;
  setMaxLines: (max: number) => void;
}

const MAX_DEFAULT = 500;

function isLiveThinking(line: AgentOutputLine): boolean {
  return !!line.thinkingLive;
}

function assignLineId(line: Omit<AgentOutputLine, 'id'>): AgentOutputLine {
  return { ...line, id: generateAgentOutputLineId() };
}

function appendLines(state: { lines: AgentOutputLine[]; maxLines: number }, incoming: AgentOutputLine[]): AgentOutputLine[] {
  const start = performance.now();
  const next = state.lines.slice();
  for (const line of incoming) {
    const lastIdx = next.length - 1;
    const last = next[lastIdx];
    if (isLiveThinking(line) && last && last.agent === line.agent && isLiveThinking(last)) {
      next[lastIdx] = line;
    } else if (!isLiveThinking(line) && last && last.agent === line.agent && isLiveThinking(last)) {
      // Final answer line replaces the live-thinking placeholder.
      next[lastIdx] = line;
    } else {
      next.push(line);
    }
  }
  if (next.length > state.maxLines) {
    next.splice(0, next.length - state.maxLines);
  }
  const duration = performance.now() - start;
  if (process.env.NODE_ENV === 'development' && duration > 1) {
    console.log(`[agentOutputStore] addLines: ${incoming.length} lines in ${duration.toFixed(2)}ms (${next.length} total)`);
  }
  return next;
}

export const useAgentOutputStore = create<AgentOutputStore>((set) => ({
  lines: [],
  maxLines: MAX_DEFAULT,
  paused: false,
  selectedAgent: null,

  addLine: (line) => {
    if (((!line?.line || line.line.trim() === '') && !line?.thinking)) return;
    set((state) => {
      const next = appendLines(state, [assignLineId(line)]);
      return { lines: next };
    });
  },

  addLines: (lines) => {
    const valid = lines.filter((l) => (l?.line && l.line.trim() !== '') || l?.thinking);
    if (valid.length === 0) return;
    set((state) => {
      const next = appendLines(state, valid.map(assignLineId));
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
