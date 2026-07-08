import { create } from 'zustand';
import type {
  AcpContentBlock,
  AcpEventPayload,
  AcpSessionState,
  AcpSessionUpdate,
  AcpToolCall,
  AcpTurn,
  AcpTurnStatus,
} from '@shared/acpTypes';

let nextTurnId = 1;

function generateTurnId(): string {
  return `turn-${nextTurnId++}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function textFromContentBlock(block: AcpContentBlock): string {
  if (block.type === 'content' && block.content.type === 'text') {
    return block.content.text;
  }
  return '';
}

export function textFromBlocks(blocks: AcpContentBlock[]): string {
  const raw = blocks.map(textFromContentBlock).join('');
  return collapseRenderedWhitespace(raw);
}

function collapseRenderedWhitespace(text: string): string {
  // Collapse runs of blank lines to a single newline and trim leading/trailing
  // whitespace so the virtualized pane doesn't balloon with empty paragraphs.
  return text.replace(/\n\s*\n/g, '\n').trim();
}

function isBlankTextBlock(block: AcpContentBlock): boolean {
  return (
    block.type === 'content' &&
    block.content.type === 'text' &&
    block.content.text.trim() === ''
  );
}

function mergeContentBlocks(existing: AcpContentBlock[], delta: AcpContentBlock[]): AcpContentBlock[] {
  if (existing.length === 0) return delta.slice();
  const last = existing[existing.length - 1];
  const first = delta[0];
  if (
    last.type === 'content' &&
    first.type === 'content' &&
    last.content.type === 'text' &&
    first.content.type === 'text'
  ) {
    return [
      ...existing.slice(0, -1),
      { type: 'content', content: { type: 'text', text: last.content.text + first.content.text } },
      ...delta.slice(1),
    ];
  }
  return [...existing, ...delta];
}

function toolCallFromEvent(toolCall: AcpToolCall): AcpToolCall {
  return { ...toolCall, contentText: textFromBlocks(toolCall.content) };
}

function mapToolCallStatus(status: AcpToolCall['status']): AcpTurnStatus {
  switch (status) {
    case 'in_progress':
      return 'tool';
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    default:
      return 'tool';
  }
}

interface AcpSessionStoreState {
  sessions: Map<string, AcpSessionState>;
}

interface AcpSessionStoreActions {
  getSession(agent: string): AcpSessionState | undefined;
  setRuntimeMode(agent: string, mode: 'acp' | 'pty'): void;
  startUserTurn(agent: string, sessionId: string, text: string, ts?: string): void;
  startAssistantTurn(agent: string, sessionId: string, ts?: string): void;
  applyEvent(payload: AcpEventPayload): void;
  respondPermission(agent: string, optionId: string): void;
  clearSession(agent: string): void;
}

function emptySession(): AcpSessionState {
  return { turns: [], activeTurnId: null };
}

function getOrCreateSession(sessions: Map<string, AcpSessionState>, agent: string): AcpSessionState {
  let session = sessions.get(agent);
  if (!session) {
    session = emptySession();
    sessions.set(agent, session);
  }
  return session;
}

function createTurn(
  agent: string,
  sessionId: string,
  role: AcpTurn['role'],
  contentBlocks: AcpContentBlock[],
  ts: string,
): AcpTurn {
  return {
    id: generateTurnId(),
    agent,
    sessionId,
    role,
    status: role === 'user' ? 'done' : 'thinking',
    content: contentBlocks,
    contentText: textFromBlocks(contentBlocks),
    thinking: '',
    toolCalls: [],
    ts,
  };
}

function updateActiveTurn(
  session: AcpSessionState,
  updater: (turn: AcpTurn) => AcpTurn,
): AcpSessionState {
  if (!session.activeTurnId) return session;
  const turns = session.turns.map((turn) => (turn.id === session.activeTurnId ? updater(turn) : turn));
  return { ...session, turns };
}

function getLastUserTurn(session: AcpSessionState): AcpTurn | undefined {
  for (let i = session.turns.length - 1; i >= 0; i--) {
    if (session.turns[i].role === 'user') return session.turns[i];
  }
  return undefined;
}

function applyAcpUpdate(session: AcpSessionState, update: AcpSessionUpdate): AcpSessionState {
  switch (update.sessionUpdate) {
    case 'initialized': {
      return {
        ...session,
        sessionId: update.sessionId,
        capabilities: update.capabilities,
        agentInfo: update.agentInfo,
      };
    }

    case 'available_commands_update': {
      return { ...session, availableCommands: update.availableCommands };
    }

    case 'agent_thought_chunk': {
      const thoughtText = textFromContentBlock(update.content);
      if (!thoughtText || thoughtText.trim() === '') return session;
      return updateActiveTurn(session, (turn) => ({
        ...turn,
        status: 'thinking',
        thinking: collapseRenderedWhitespace(turn.thinking + thoughtText),
      }));
    }

    case 'agent_message_chunk': {
      if (isBlankTextBlock(update.content)) return session;
      const messageText = textFromContentBlock(update.content);
      // Some ACP providers echo the last user message as the first assistant
      // chunk. Suppress that exact echo so the user bubble stays the single
      // source of truth for what the user typed.
      const lastUser = getLastUserTurn(session);
      if (lastUser && messageText && collapseRenderedWhitespace(messageText) === lastUser.contentText) {
        return session;
      }
      return updateActiveTurn(session, (turn) => {
        const nextContent = mergeContentBlocks(turn.content, [update.content]);
        return {
          ...turn,
          status: 'answering',
          content: nextContent,
          contentText: textFromBlocks(nextContent),
        };
      });
    }

    case 'tool_call': {
      return updateActiveTurn(session, (turn) => {
        const toolCall = toolCallFromEvent(update.toolCall);
        const existingIndex = turn.toolCalls.findIndex((t) => t.toolCallId === toolCall.toolCallId);
        const toolCalls =
          existingIndex >= 0
            ? turn.toolCalls.map((t, i) => (i === existingIndex ? toolCall : t))
            : [...turn.toolCalls, toolCall];
        return {
          ...turn,
          status: toolCall.status === 'in_progress' ? 'tool' : mapToolCallStatus(toolCall.status),
          toolCalls,
        };
      });
    }

    case 'tool_call_update': {
      return updateActiveTurn(session, (turn) => {
        const updated = update.toolCall;
        const existingIndex = turn.toolCalls.findIndex((t) => t.toolCallId === updated.toolCallId);
        if (existingIndex < 0) {
          return {
            ...turn,
            status: updated.status === 'in_progress' ? 'tool' : mapToolCallStatus(updated.status),
            toolCalls: [...turn.toolCalls, toolCallFromEvent(updated)],
          };
        }
        const existing = turn.toolCalls[existingIndex];
        const mergedContent = mergeContentBlocks(existing.content, updated.content);
        const toolCall: AcpToolCall = {
          ...updated,
          content: mergedContent,
          contentText: textFromBlocks(mergedContent),
        };
        const toolCalls = turn.toolCalls.map((t, i) => (i === existingIndex ? toolCall : t));
        return {
          ...turn,
          status: updated.status === 'in_progress' ? 'tool' : mapToolCallStatus(updated.status),
          toolCalls,
        };
      });
    }

    case 'permission_request': {
      return {
        ...session,
        pendingPermission: {
          requestId: update.requestId,
          options: update.options,
          toolCall: update.toolCall,
        },
      };
    }

    case 'turn_complete': {
      if (!session.activeTurnId) return session;
      const turns = session.turns.map((turn) =>
        turn.id === session.activeTurnId
          ? { ...turn, status: 'done' as AcpTurnStatus, stopReason: update.stopReason }
          : turn,
      );
      return { ...session, turns, activeTurnId: null };
    }

    case 'error': {
      return { ...session, error: update.error };
    }

    case 'stderr': {
      // stderr is not rendered in the transcript; could be logged later.
      return session;
    }

    default: {
      return session;
    }
  }
}

export const useAcpSessionStore = create<AcpSessionStoreState & AcpSessionStoreActions>(
  (set, get) => ({
    sessions: new Map(),

    getSession(agent: string) {
      return get().sessions.get(agent);
    },

    setRuntimeMode(agent: string, mode: 'acp' | 'pty') {
      set((state) => {
        const sessions = new Map(state.sessions);
        const session = getOrCreateSession(sessions, agent);
        session.runtimeMode = mode;
        return { sessions };
      });
    },

    startUserTurn(agent: string, sessionId: string, text: string, ts = new Date().toISOString()) {
      set((state) => {
        const sessions = new Map(state.sessions);
        const session = getOrCreateSession(sessions, agent);
        const turn = createTurn(
          agent,
          sessionId,
          'user',
          [{ type: 'content', content: { type: 'text', text } }],
          ts,
        );
        sessions.set(agent, { ...session, turns: [...session.turns, turn], activeTurnId: null });
        return { sessions };
      });
    },

    startAssistantTurn(agent: string, sessionId: string, ts = new Date().toISOString()) {
      set((state) => {
        const sessions = new Map(state.sessions);
        const session = getOrCreateSession(sessions, agent);
        const turn = createTurn(agent, sessionId, 'assistant', [], ts);
        sessions.set(agent, { ...session, turns: [...session.turns, turn], activeTurnId: turn.id });
        return { sessions };
      });
    },

    applyEvent(payload: AcpEventPayload) {
      set((state) => {
        const sessions = new Map(state.sessions);
        const session = getOrCreateSession(sessions, payload.agent);
        if (session.runtimeMode !== 'acp') {
          session.runtimeMode = 'acp';
        }
        if (payload.sessionId && session.sessionId !== payload.sessionId) {
          session.sessionId = payload.sessionId;
        }
        sessions.set(payload.agent, applyAcpUpdate(session, payload.update));
        return { sessions };
      });
    },

    respondPermission(agent: string, optionId: string) {
      set((state) => {
        const sessions = new Map(state.sessions);
        const session = sessions.get(agent);
        if (!session?.pendingPermission) return state;
        const option = session.pendingPermission.options.find((o) => o.optionId === optionId);
        if (!option) return state;
        // Update the associated tool call status based on the response.
        const toolCallId = session.pendingPermission.toolCall.toolCallId;
        const turns = session.turns.map((turn) => {
          const toolIndex = turn.toolCalls.findIndex((t) => t.toolCallId === toolCallId);
          if (toolIndex < 0) return turn;
          const status: AcpToolCall['status'] = option.kind.startsWith('allow') ? 'completed' : 'failed';
          const toolCalls = turn.toolCalls.map((t, i) =>
            i === toolIndex ? { ...t, status, contentText: t.contentText ?? textFromBlocks(t.content) } : t,
          );
          return { ...turn, toolCalls, status: (status === 'failed' ? 'error' : 'done') as AcpTurnStatus };
        });
        sessions.set(agent, { ...session, turns, pendingPermission: undefined });
        return { sessions };
      });
    },

    clearSession(agent: string) {
      set((state) => {
        const sessions = new Map(state.sessions);
        sessions.delete(agent);
        return { sessions };
      });
    },
  }),
);
