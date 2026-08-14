import { describe, it, expect, beforeEach } from 'vitest';
import { useAcpSessionStore } from './acpSessionStore';
import type { AcpEventPayload } from '@shared/acpTypes';

function makeUpdate(agent: string, update: AcpEventPayload['update']): AcpEventPayload {
  return { agent, sessionId: update.sessionId ?? 's1', update };
}

describe('acpSessionStore', () => {
  beforeEach(() => {
    useAcpSessionStore.setState({ sessions: new Map() });
  });

  it('creates a user turn and clears active turn', () => {
    useAcpSessionStore.getState().startUserTurn('NextPert', 's1', 'Hello Kimi');
    const session = useAcpSessionStore.getState().getSession('NextPert');
    expect(session?.turns).toHaveLength(1);
    expect(session?.turns[0].role).toBe('user');
    expect(session?.turns[0].contentText).toBe('Hello Kimi');
    expect(session?.activeTurnId).toBeNull();
  });

  it('creates a user turn with image content blocks', () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    useAcpSessionStore.getState().startUserTurn('NextPert', 's1', 'Look at this', [
      { id: 'img-1', name: 'test.png', type: 'image/png', data },
    ]);
    const session = useAcpSessionStore.getState().getSession('NextPert');
    expect(session?.turns).toHaveLength(1);
    expect(session?.turns[0].role).toBe('user');
    expect(session?.turns[0].content).toHaveLength(2);
    expect(session?.turns[0].content[0]).toEqual({
      type: 'content',
      content: { type: 'text', text: 'Look at this' },
    });
    expect(session?.turns[0].content[1]).toEqual({
      type: 'content',
      content: { type: 'image', data: 'iVBORw==', mimeType: 'image/png' },
    });
    expect(session?.turns[0].contentText).toBe('Look at this');
  });

  it('records initialized event details', () => {
    const store = useAcpSessionStore.getState();
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'initialized',
        sessionId: 's1',
        capabilities: { loadSession: true },
        agentInfo: { name: 'Kimi Code CLI', version: '1.0.0' },
      }),
    );
    const session = store.getSession('NextPert');
    expect(session?.sessionId).toBe('s1');
    expect(session?.agentInfo?.name).toBe('Kimi Code CLI');
  });

  it('records the spawn command as a banner, never as a transcript turn', () => {
    const store = useAcpSessionStore.getState();
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'spawn_info',
        command: 'kimi --yolo -m kimi-code/k3 acp  KIMI_MODEL_THINKING_EFFORT=high',
      }),
    );
    const session = store.getSession('NextPert');
    expect(session?.spawnCommand).toBe(
      'kimi --yolo -m kimi-code/k3 acp  KIMI_MODEL_THINKING_EFFORT=high',
    );
    // QA guard: system lines stay OUT of the transcript.
    expect(session?.turns).toHaveLength(0);
  });

  it('creates an assistant turn and accumulates thinking chunks', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_thought_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: 'The' } },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_thought_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: ' user wants' } },
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.turns[0].thinking).toBe('The user wants');
    expect(session?.turns[0].status).toBe('thinking');
  });

  it('merges message chunks into content text', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: 'Here' } },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: ' is the answer.' } },
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.turns[0].contentText).toBe('Here is the answer.');
    expect(session?.turns[0].status).toBe('answering');
  });

  it('adds and updates tool calls without fracture', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'tool_call',
        sessionId: 's1',
        toolCall: {
          toolCallId: 'tc1',
          title: 'Shell',
          status: 'in_progress',
          content: [{ type: 'content', content: { type: 'text', text: '' } }],
        },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'tool_call_update',
        sessionId: 's1',
        toolCall: {
          toolCallId: 'tc1',
          title: 'Shell: dir',
          status: 'in_progress',
          content: [{ type: 'content', content: { type: 'text', text: '{"command": "dir"}' } }],
        },
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.turns[0].toolCalls).toHaveLength(1);
    expect(session?.turns[0].toolCalls[0].title).toBe('Shell: dir');
    expect(session?.turns[0].toolCalls[0].contentText).toBe('{"command": "dir"}');
    expect(session?.turns[0].status).toBe('tool');
  });

  it('finalizes the active turn on turn_complete', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: 'Done.' } },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'turn_complete',
        sessionId: 's1',
        stopReason: 'end_turn',
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.turns[0].status).toBe('done');
    expect(session?.turns[0].stopReason).toBe('end_turn');
    expect(session?.activeTurnId).toBeNull();
  });

  it('records wait_state and clears it when content arrives', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'wait_state',
        sessionId: 's1',
        waitState: {
          kind: 'provider_retry',
          failedAttempt: 2,
          nextAttempt: 3,
          maxAttempts: 10,
          delayMs: 12_000,
          errorName: 'APITimeoutError',
          statusCode: 408,
        },
      }),
    );

    let session = store.getSession('NextPert');
    expect(session?.waitState).toMatchObject({
      kind: 'provider_retry',
      nextAttempt: 3,
      maxAttempts: 10,
      delayMs: 12_000,
    });

    // The retry succeeded and content is streaming again — the wait is over.
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: 'Recovered.' } },
      }),
    );
    session = store.getSession('NextPert');
    expect(session?.waitState).toBeUndefined();
  });

  it('clears wait_state on turn_complete', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'wait_state',
        sessionId: 's1',
        waitState: { kind: 'awaiting_first_token' },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'turn_complete',
        sessionId: 's1',
        stopReason: 'end_turn',
      }),
    );

    expect(store.getSession('NextPert')?.waitState).toBeUndefined();
  });

  it('opens an assistant turn on turn_started even when the previous turn is done (card 182119)', () => {
    const store = useAcpSessionStore.getState();
    // A completed turn, then a manager dispatch for a NEW turn (mail-injected
    // or queue-drained — no user send): the pill must go busy.
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', { sessionUpdate: 'turn_complete', sessionId: 's1', stopReason: 'end_turn' }),
    );
    expect(store.getSession('NextPert')?.activeTurnId).toBeNull();

    store.applyEvent(makeUpdate('NextPert', { sessionUpdate: 'turn_started', sessionId: 's1' }));
    const session = store.getSession('NextPert');
    expect(session?.activeTurnId).not.toBeNull();
    expect(session?.turns.at(-1)?.role).toBe('assistant');
    expect(session?.turns.at(-1)?.status).toBe('thinking');
  });

  it('turn_started is a no-op while a turn is already active', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    const activeId = store.getSession('NextPert')?.activeTurnId;
    const turnCount = store.getSession('NextPert')?.turns.length;

    store.applyEvent(makeUpdate('NextPert', { sessionUpdate: 'turn_started', sessionId: 's1' }));

    const session = store.getSession('NextPert');
    expect(session?.activeTurnId).toBe(activeId);
    expect(session?.turns.length).toBe(turnCount);
  });

  it('ignores a wait_state update with a missing kind', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'wait_state',
        sessionId: 's1',
        waitState: { kind: '' },
      }),
    );

    expect(store.getSession('NextPert')?.waitState).toBeUndefined();
  });

  it('ignores queue-state events without tracking depth — queue UX is cut (WO 11645)', () => {
    const store = useAcpSessionStore.getState();
    store.applyEvent(
      makeUpdate('NextPert', { sessionUpdate: 'prompt_queued', sessionId: 's1', queueDepth: 1 }),
    );
    store.applyEvent(
      makeUpdate('NextPert', { sessionUpdate: 'prompt_queued', sessionId: 's1', queueDepth: 2 }),
    );
    store.applyEvent(
      makeUpdate('NextPert', { sessionUpdate: 'prompt_dequeued', sessionId: 's1', queueDepth: 1 }),
    );
    store.applyEvent(
      makeUpdate('NextPert', { sessionUpdate: 'queue_cleared', sessionId: 's1' }),
    );

    // Events are consumed without error and no queue depth is tracked.
    expect(store.getSession('NextPert')).not.toHaveProperty('queuedCount');
  });

  it('clears waitState on initialized (runtime restart)', () => {
    const store = useAcpSessionStore.getState();
    store.applyEvent(
      makeUpdate('NextPert', { sessionUpdate: 'prompt_queued', sessionId: 's1', queueDepth: 2 }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'wait_state',
        sessionId: 's1',
        waitState: { kind: 'provider_retry', nextAttempt: 3, maxAttempts: 10 },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'initialized',
        sessionId: 's1',
        capabilities: {},
        agentInfo: { name: 'Kimi' },
      }),
    );

    const session = store.getSession('NextPert');
    expect(session).not.toHaveProperty('queuedCount');
    expect(session?.waitState).toBeUndefined();
  });

  it('marks in-progress tools as completed on turn_complete', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'tool_call',
        sessionId: 's1',
        toolCall: {
          toolCallId: 'tc1',
          title: 'WriteFile',
          status: 'in_progress',
          content: [],
        },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'tool_call',
        sessionId: 's1',
        toolCall: {
          toolCallId: 'tc2',
          title: 'WriteFile',
          status: 'in_progress',
          content: [],
        },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'turn_complete',
        sessionId: 's1',
        stopReason: 'end_turn',
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.turns[0].toolCalls).toHaveLength(2);
    expect(session?.turns[0].toolCalls[0].status).toBe('completed');
    expect(session?.turns[0].toolCalls[1].status).toBe('completed');
    expect(session?.turns[0].status).toBe('done');
  });

  it('marks in-progress tools as failed on failActiveTurn', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'tool_call',
        sessionId: 's1',
        toolCall: {
          toolCallId: 'tc1',
          title: 'WriteFile',
          status: 'in_progress',
          content: [],
        },
      }),
    );
    store.failActiveTurn('NextPert', 'connection lost');

    const session = store.getSession('NextPert');
    expect(session?.turns[0].toolCalls[0].status).toBe('failed');
    expect(session?.turns[0].status).toBe('error');
  });

  it('stops an active assistant turn without marking it as a send failure', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'tool_call',
        sessionId: 's1',
        toolCall: {
          toolCallId: 'tc1',
          title: 'WriteFile',
          status: 'in_progress',
          content: [],
        },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: 'Partial answer' } },
      }),
    );
    store.stopActiveTurn('NextPert', 'interrupted');

    const session = store.getSession('NextPert');
    expect(session?.turns[0].status).toBe('done');
    expect(session?.turns[0].stopReason).toBe('interrupted');
    expect(session?.turns[0].contentText).toBe('Partial answer');
    expect(session?.turns[0].toolCalls[0].status).toBe('failed');
    expect(session?.activeTurnId).toBeNull();
    expect(session?.error).toBeUndefined();
  });

  it('stores pending permission requests', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'permission_request',
        sessionId: 's1',
        requestId: 42,
        options: [{ optionId: 'approve', name: 'Approve', kind: 'allow_once' }],
        toolCall: {
          toolCallId: 'tc1',
          title: 'Shell',
          status: 'in_progress',
          content: [],
        },
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.pendingPermission?.requestId).toBe(42);
  });

  it('isolates sessions per agent', () => {
    const store = useAcpSessionStore.getState();
    store.startUserTurn('NextPert', 's1', 'Hi');
    store.startUserTurn('DotNetPert', 's2', 'Hello');

    expect(store.getSession('NextPert')?.turns).toHaveLength(1);
    expect(store.getSession('DotNetPert')?.turns).toHaveLength(1);
    expect(store.getSession('NextPert')?.turns[0].contentText).toBe('Hi');
  });

  it('integrates a full assistant turn from raw session/update events', () => {
    const store = useAcpSessionStore.getState();

    // Initialize the session.
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'initialized',
        sessionId: 'sess-int',
        capabilities: { loadSession: true },
        agentInfo: { name: 'Kimi', version: '1.0' },
      }),
    );

    // User sends a prompt.
    store.startUserTurn('NextPert', 'sess-int', 'List files');

    // Assistant turn begins and streams events.
    store.startAssistantTurn('NextPert', 'sess-int');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_thought_chunk',
        sessionId: 'sess-int',
        content: { type: 'content', content: { type: 'text', text: 'The user wants' } },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_thought_chunk',
        sessionId: 'sess-int',
        content: { type: 'content', content: { type: 'text', text: ' a directory listing.' } },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'tool_call',
        sessionId: 'sess-int',
        toolCall: {
          toolCallId: 'tc-list',
          title: 'Shell: ls',
          status: 'in_progress',
          content: [],
        },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'tool_call_update',
        sessionId: 'sess-int',
        toolCall: {
          toolCallId: 'tc-list',
          title: 'Shell: ls',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'README.md\nsrc\n' } }],
        },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 'sess-int',
        content: { type: 'content', content: { type: 'text', text: 'Here are the files:' } },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 'sess-int',
        content: { type: 'content', content: { type: 'text', text: ' README.md, src.' } },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'turn_complete',
        sessionId: 'sess-int',
        stopReason: 'end_turn',
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.sessionId).toBe('sess-int');
    expect(session?.runtimeMode).toBe('acp');
    expect(session?.turns).toHaveLength(2);

    const userTurn = session?.turns[0];
    expect(userTurn?.role).toBe('user');
    expect(userTurn?.contentText).toBe('List files');

    const assistantTurn = session?.turns[1];
    expect(assistantTurn?.role).toBe('assistant');
    expect(assistantTurn?.status).toBe('done');
    expect(assistantTurn?.thinking).toBe('The user wants a directory listing.');
    expect(assistantTurn?.contentText).toBe('Here are the files: README.md, src.');
    expect(assistantTurn?.toolCalls).toHaveLength(1);
    expect(assistantTurn?.toolCalls[0].toolCallId).toBe('tc-list');
    expect(assistantTurn?.toolCalls[0].status).toBe('completed');
    expect(assistantTurn?.toolCalls[0].contentText).toBe('README.md\nsrc');
    expect(session?.activeTurnId).toBeNull();
  });

  it('ignores blank thought chunks', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_thought_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: 'Useful thought.' } },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_thought_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: '   \n  ' } },
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.turns[0].thinking).toBe('Useful thought.');
  });

  it('ignores blank message chunks', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: 'Hello' } },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: '\n\n   \n' } },
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.turns[0].contentText).toBe('Hello');
  });

  it('collapses multiple blank lines in content text', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: 'Line 1\n\n\n\nLine 2\n\n' } },
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.turns[0].contentText).toBe('Line 1\nLine 2');
  });

  it('fails the active assistant turn and clears activeTurnId', () => {
    const store = useAcpSessionStore.getState();
    store.startUserTurn('NextPert', 's1', 'Hello');
    store.startAssistantTurn('NextPert', 's1');
    store.failActiveTurn('NextPert', 'IPC failure');

    const session = store.getSession('NextPert');
    expect(session?.activeTurnId).toBeNull();
    expect(session?.error).toBe('IPC failure');
    const assistantTurn = session?.turns.find((t) => t.role === 'assistant');
    expect(assistantTurn?.status).toBe('error');
    expect(assistantTurn?.contentText).toContain('IPC failure');
  });

  it('fails the active assistant turn on an error update', () => {
    const store = useAcpSessionStore.getState();
    store.startUserTurn('NextPert', 's1', 'Hello');
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'tool_call',
        sessionId: 's1',
        toolCall: {
          toolCallId: 'tc1',
          title: 'Shell',
          status: 'in_progress',
          content: [],
        },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'error',
        sessionId: 's1',
        error: 'ACP process exited',
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.activeTurnId).toBeNull();
    expect(session?.error).toBe('ACP process exited');
    const assistantTurn = session?.turns.find((t) => t.role === 'assistant');
    expect(assistantTurn?.status).toBe('error');
    expect(assistantTurn?.contentText).toContain('ACP process exited');
    expect(assistantTurn?.toolCalls[0].status).toBe('failed');
  });

  it('records an error update when no assistant turn is active', () => {
    const store = useAcpSessionStore.getState();
    store.startUserTurn('NextPert', 's1', 'Hello');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'error',
        sessionId: 's1',
        error: 'runtime not initialized',
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.activeTurnId).toBeNull();
    expect(session?.error).toBe('runtime not initialized');
    const assistantTurn = session?.turns.find((t) => t.role === 'assistant');
    expect(assistantTurn).toBeUndefined();
  });

  it('does not resurrect an active assistant turn from chunks after turn_complete', () => {
    const store = useAcpSessionStore.getState();
    store.startUserTurn('NextPert', 's1', 'Look at this image');
    store.startAssistantTurn('NextPert', 's1');
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: 'I see it.' } },
      }),
    );
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'turn_complete',
        sessionId: 's1',
        stopReason: 'end_turn',
      }),
    );

    // Simulate a stray chunk delivered after the runtime already signaled
    // turn completion. This reproduces the image-paste "Answering..." hang
    // where a late session/update chunk creates a new active turn with no
    // matching turn_complete event.
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: 'late fragment' } },
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.turns).toHaveLength(2);
    expect(session?.activeTurnId).toBeNull();
    expect(session?.turns[1].status).toBe('done');
    expect(session?.turns[1].contentText).toBe('I see it.');
  });

  it('tolerates malformed ACP events with missing content blocks', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');

    // Missing content should not throw.
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 's1',
        content: undefined,
      } as any),
    );

    // Null content in an array should be filtered out.
    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 's1',
        content: { type: 'content', content: { type: 'text', text: 'Hello' } },
      }),
    );

    const session = store.getSession('NextPert');
    expect(session?.turns[0].contentText).toBe('Hello');
    expect(session?.turns[0].status).toBe('answering');
  });

  it('tolerates malformed ACP events with missing toolCall', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');

    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'tool_call',
        sessionId: 's1',
        toolCall: undefined,
      } as any),
    );

    store.applyEvent(
      makeUpdate('NextPert', {
        sessionUpdate: 'tool_call_update',
        sessionId: 's1',
        toolCall: undefined,
      } as any),
    );

    const session = useAcpSessionStore.getState().getSession('NextPert');
    expect(session?.turns[0].toolCalls).toHaveLength(0);
  });

  it('tolerates a completely null/undefined update payload', () => {
    const store = useAcpSessionStore.getState();
    store.startAssistantTurn('NextPert', 's1');

    store.applyEvent({ agent: 'NextPert', sessionId: 's1', update: undefined as unknown as AcpEventPayload['update'] });

    const session = store.getSession('NextPert');
    expect(session?.turns).toHaveLength(1);
    expect(session?.activeTurnId).not.toBeNull();
  });
});
