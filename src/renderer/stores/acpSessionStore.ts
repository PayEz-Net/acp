import { create } from 'zustand';
import { stripAnsi } from '../lib/ansi';
import type {
  AcpContentBlock,
  AcpEventPayload,
  AcpSessionState,
  AcpSessionUpdate,
  AcpToolCall,
  AcpTurn,
  AcpTurnStatus,
} from '@shared/acpTypes';

export interface StagedImageInput {
  id: string;
  name: string;
  type: string;
  data: ArrayBuffer;
}

let nextTurnId = 1;

function generateTurnId(): string {
  return `turn-${nextTurnId++}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function textFromContentBlock(block: AcpContentBlock | null | undefined): string {
  if (!block) return '';
  if (block.type === 'content' && block.content && block.content.type === 'text') {
    return stripAnsi(block.content.text);
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

const MAX_THINKING_CHARS = 250;

function truncateThinking(text: string): string {
  if (text.length <= MAX_THINKING_CHARS) return text;
  // Keep the tail so the user sees the most recent reasoning; slice at a word
  // boundary so the preview doesn't start mid-token.
  const tail = text.slice(-MAX_THINKING_CHARS);
  const firstSpace = tail.indexOf(' ');
  return firstSpace > 0 ? tail.slice(firstSpace + 1) : tail;
}

function isBlankTextBlock(block: AcpContentBlock | null | undefined): boolean {
  if (!block) return true;
  return (
    block.type === 'content' &&
    block.content &&
    block.content.type === 'text' &&
    block.content.text.trim() === ''
  );
}

function appendTextDedupe(existing: string, delta: string): string {
  if (!existing) return delta;
  if (!delta) return existing;
  // Cumulative/overlapping chunk handling for plain-string streams.
  if (delta.startsWith(existing)) return delta;
  if (existing.endsWith(delta)) return existing;
  return existing + delta;
}

function mergeContentBlocks(existing: AcpContentBlock[], delta: AcpContentBlock[]): AcpContentBlock[] {
  const safeDelta = delta.filter((b): b is AcpContentBlock => b != null);
  if (existing.length === 0) return safeDelta.slice();
  const last = existing[existing.length - 1];
  const first = safeDelta[0];
  if (
    first &&
    last &&
    last.type === 'content' &&
    first.type === 'content' &&
    last.content &&
    first.content &&
    last.content.type === 'text' &&
    first.content.type === 'text'
  ) {
    const prev = last.content.text;
    const next = first.content.text;
    // Some ACP providers stream cumulative text (each chunk restarts from the
    // beginning) or overlapping fragments. Detect and de-duplicate so the
    // rendered answer never repeats itself.
    if (next.startsWith(prev)) {
      return [{ type: 'content', content: { type: 'text', text: next } }, ...safeDelta.slice(1)];
    }
    if (prev.endsWith(next)) {
      return [...existing, ...safeDelta.slice(1)];
    }
    return [
      ...existing.slice(0, -1),
      { type: 'content', content: { type: 'text', text: prev + next } },
      ...safeDelta.slice(1),
    ];
  }
  return [...existing, ...safeDelta];
}

function toolCallFromEvent(toolCall: AcpToolCall | null | undefined): AcpToolCall {
  if (!toolCall) {
    return {
      toolCallId: '',
      title: '',
      status: 'failed',
      content: [],
      contentText: '',
    };
  }
  return { ...toolCall, contentText: textFromBlocks(toolCall.content ?? []) };
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
  startUserTurn(agent: string, sessionId: string, text: string, images?: StagedImageInput[], ts?: string): void;
  startAssistantTurn(agent: string, sessionId: string, ts?: string): void;
  failActiveTurn(agent: string, error?: string): void;
  stopActiveTurn(agent: string, stopReason?: string): void;
  applyEvent(payload: AcpEventPayload): void;
  applyEvents(payloads: AcpEventPayload[]): void;
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

function ensureAssistantTurn(session: AcpSessionState, agent: string, sessionId: string): AcpSessionState {
  if (session.activeTurnId) return session;
  // Don't create a new active assistant turn from stray chunks that arrive
  // after the previous assistant turn already completed (e.g., a final
  // message chunk delivered after turn_complete). Without this guard, the
  // transcript shows an eternal "Answering..." spinner for a turn that has
  // no matching turn_complete event. The boot-prompt case is still covered:
  // there is either no prior turn or the prior turn is the user turn.
  const lastTurn = session.turns[session.turns.length - 1];
  if (lastTurn?.role === 'assistant' && lastTurn.status === 'done') return session;
  const turn = createTurn(agent, sessionId, 'assistant', [], new Date().toISOString());
  return { ...session, turns: [...session.turns, turn], activeTurnId: turn.id };
}

/**
 * Updates that prove the runtime is producing output again (or is now
 * blocked on the user), ending any recorded provider wait-state. Mirrors
 * the meaningful-activity set in AcpRuntimeManager, minus `plan` (not
 * handled by this store) and `wait_state` itself.
 */
const WAIT_STATE_CLEARING_UPDATES = new Set([
  'agent_thought_chunk',
  'agent_message_chunk',
  'tool_call',
  'tool_call_update',
  'permission_request',
  'turn_complete',
  'error',
]);

function applyAcpUpdate(session: AcpSessionState, update: AcpSessionUpdate | null | undefined, agent: string): AcpSessionState {
  if (!update || typeof update !== 'object') {
    console.warn(`[acpSessionStore] Ignoring malformed update for ${agent}: update is null or not an object`);
    return session;
  }
  // Any content-bearing or terminal update means the runtime is producing
  // again (or now waiting on the user): the recorded wait-state — provider
  // first-token latency or retry backoff — is over.
  if (WAIT_STATE_CLEARING_UPDATES.has(update.sessionUpdate)) {
    session = { ...session, waitState: undefined };
  }
  switch (update.sessionUpdate) {
    case 'initialized': {
      // Runtime (re)start: any queue/wait state from the previous process is
      // gone — clear both so no stale indicators survive the restart.
      return {
        ...session,
        sessionId: update.sessionId,
        capabilities: update.capabilities,
        // Claude emits TWO 'initialized' updates — the synthetic handshake
        // (name only) and the mapper's real one (name+version+model+effort) —
        // and they can arrive in either order. Merge so a later barer update
        // never erases the richer fields an earlier one already set; on a real
        // restart the fresh update's present fields still win.
        agentInfo: update.agentInfo
          ? { ...session.agentInfo, ...update.agentInfo }
          : session.agentInfo,
        imageIn: update.imageIn,
        waitState: undefined,
      };
    }

    case 'available_commands_update': {
      return { ...session, availableCommands: update.availableCommands };
    }

    case 'agent_thought_chunk': {
      if (!update.content || typeof update.content !== 'object') {
        console.warn(`[acpSessionStore] Ignoring agent_thought_chunk for ${agent}: missing or invalid content`);
        return session;
      }
      session = ensureAssistantTurn(session, agent, session.sessionId ?? '');
      const thoughtText = textFromContentBlock(update.content);
      if (!thoughtText || thoughtText.trim() === '') return session;
      return updateActiveTurn(session, (turn) => ({
        ...turn,
        status: 'thinking',
        // Keep thinking compact: cap at ~250 chars (roughly 3-4 wrapped lines)
        // so live reasoning doesn't balloon and push useful output off-screen.
        thinking: truncateThinking(
          collapseRenderedWhitespace(appendTextDedupe(turn.thinking, thoughtText)),
        ),
      }));
    }

    case 'agent_message_chunk': {
      if (!update.content || typeof update.content !== 'object') {
        console.warn(`[acpSessionStore] Ignoring agent_message_chunk for ${agent}: missing or invalid content`);
        return session;
      }
      session = ensureAssistantTurn(session, agent, session.sessionId ?? '');
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
      if (!update.toolCall) {
        console.warn(`[acpSessionStore] Ignoring tool_call update for ${agent}: toolCall is missing`);
        return session;
      }
      session = ensureAssistantTurn(session, agent, session.sessionId ?? '');
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
      if (!update.toolCall) {
        console.warn(`[acpSessionStore] Ignoring tool_call_update for ${agent}: toolCall is missing`);
        return session;
      }
      session = ensureAssistantTurn(session, agent, session.sessionId ?? '');
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

    case 'wait_state': {
      if (!update.waitState || typeof update.waitState.kind !== 'string' || update.waitState.kind === '') {
        console.warn(`[acpSessionStore] Ignoring wait_state for ${agent}: missing or invalid kind`);
        return session;
      }
      return { ...session, waitState: update.waitState };
    }

    case 'turn_complete': {
      if (!session.activeTurnId) return session;
      const turns = session.turns.map((turn) =>
        turn.id === session.activeTurnId
          ? {
              ...turn,
              status: 'done' as AcpTurnStatus,
              stopReason: update.stopReason,
              // If the runtime finishes the turn without sending a completed
              // tool_call_update for every tool, mark remaining in-progress
              // tools as completed so their spinners don't spin forever.
              toolCalls: turn.toolCalls.map((t) =>
                t.status === 'in_progress' ? { ...t, status: 'completed' as const } : t,
              ),
            }
          : turn,
      );
      return { ...session, turns, activeTurnId: null };
    }

    case 'error': {
      // An error while a turn is active means the assistant turn will never
      // receive a matching turn_complete. Fail it now so the activity spinner,
      // live thinking block, and any in-progress tool spinners all stop.
      if (!session.activeTurnId) {
        return { ...session, error: update.error };
      }
      const turns = session.turns.map((turn) =>
        turn.id === session.activeTurnId
          ? {
              ...turn,
              status: 'error' as AcpTurnStatus,
              contentText: update.error ? `[Send failed] ${update.error}` : turn.contentText,
              // Mark any still-running tools as failed so their spinners stop.
              toolCalls: turn.toolCalls.map((t) =>
                t.status === 'in_progress' ? { ...t, status: 'failed' as const } : t,
              ),
            }
          : turn,
      );
      return { ...session, turns, activeTurnId: null, error: update.error };
    }

    case 'stderr': {
      // stderr is not rendered in the transcript; could be logged later.
      return session;
    }

    case 'spawn_info': {
      // Banner line above the pane, NOT a transcript turn (QA: no system
      // lines in the transcript).
      return { ...session, spawnCommand: update.command };
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

    startUserTurn(
      agent: string,
      sessionId: string,
      text: string,
      images: StagedImageInput[] = [],
      ts = new Date().toISOString(),
    ) {
      set((state) => {
        const sessions = new Map(state.sessions);
        const session = getOrCreateSession(sessions, agent);
        const contentBlocks: AcpContentBlock[] = [{ type: 'content', content: { type: 'text', text } }];
        for (const image of images) {
          contentBlocks.push({
            type: 'content',
            content: { type: 'image', data: arrayBufferToBase64(image.data), mimeType: image.type },
          });
        }
        const turn = createTurn(agent, sessionId, 'user', contentBlocks, ts);
        // A user message does NOT end the active assistant turn — only
        // turn_complete / cancel does. Nulling activeTurnId here orphaned the
        // live turn and fragmented the transcript on the next chunk (slice B:
        // steered messages arrive mid-turn by design).
        sessions.set(agent, { ...session, turns: [...session.turns, turn] });
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

    failActiveTurn(agent: string, error?: string) {
      set((state) => {
        const sessions = new Map(state.sessions);
        const session = sessions.get(agent);
        if (!session?.activeTurnId) return state;
        const turns = session.turns.map((turn) =>
          turn.id === session.activeTurnId
            ? {
                ...turn,
                status: 'error' as AcpTurnStatus,
                contentText: error ? `[Send failed] ${error}` : turn.contentText,
                // Mark any still-running tools as failed so their spinners stop.
                toolCalls: turn.toolCalls.map((t) =>
                  t.status === 'in_progress' ? { ...t, status: 'failed' as const } : t,
                ),
              }
            : turn,
        );
        sessions.set(agent, { ...session, turns, activeTurnId: null, error });
        return { sessions };
      });
    },

    stopActiveTurn(agent: string, stopReason = 'interrupted') {
      set((state) => {
        const sessions = new Map(state.sessions);
        const session = sessions.get(agent);
        if (!session?.activeTurnId) return state;
        const turns = session.turns.map((turn) =>
          turn.id === session.activeTurnId
            ? {
                ...turn,
                status: 'done' as AcpTurnStatus,
                stopReason,
                // Mark any still-running tools as failed so their spinners stop.
                // The turn itself is not an error; the assistant was simply cut off
                // by a newer user message.
                toolCalls: turn.toolCalls.map((t) =>
                  t.status === 'in_progress' ? { ...t, status: 'failed' as const } : t,
                ),
              }
            : turn,
        );
        sessions.set(agent, { ...session, turns, activeTurnId: null });
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
        sessions.set(payload.agent, applyAcpUpdate(session, payload.update, payload.agent));
        return { sessions };
      });
    },

    applyEvents(payloads: AcpEventPayload[]) {
      if (payloads.length === 0) return;
      set((state) => {
        const sessions = new Map(state.sessions);
        for (const payload of payloads) {
          const session = getOrCreateSession(sessions, payload.agent);
          if (session.runtimeMode !== 'acp') {
            session.runtimeMode = 'acp';
          }
          if (payload.sessionId && session.sessionId !== payload.sessionId) {
            session.sessionId = payload.sessionId;
          }
          sessions.set(payload.agent, applyAcpUpdate(session, payload.update, payload.agent));
        }
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
