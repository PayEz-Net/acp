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
});
