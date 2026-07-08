import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

import { AcpTranscript } from './AcpTranscript';
import { AssistantTurn } from './AssistantTurn';
import { UserTurn } from './UserTurn';
import { ToolCallCard } from './ToolCallCard';
import { useAcpSessionStore } from '../../stores/acpSessionStore';
import type { AcpTurn, AcpToolCall } from '@shared/acpTypes';

const mockSendAcpPermissionResponse = vi.fn().mockResolvedValue(undefined);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

function cleanup(root: ReturnType<typeof createRoot>, container: HTMLElement) {
  act(() => {
    root.unmount();
  });
  document.body.removeChild(container);
}

function makeTurn(overrides: Partial<AcpTurn> = {}): AcpTurn {
  return {
    id: 't1',
    agent: 'NextPert',
    sessionId: 's1',
    role: 'assistant',
    status: 'done',
    content: [],
    contentText: '',
    thinking: '',
    toolCalls: [],
    ts: new Date().toISOString(),
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<AcpToolCall> = {}): AcpToolCall {
  return {
    toolCallId: 'tc1',
    title: 'Shell: dir',
    status: 'in_progress',
    content: [{ type: 'content', content: { type: 'text', text: '{"command":"dir"}' } }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('electronAPI', {
    sendAcpPermissionResponse: mockSendAcpPermissionResponse,
  });
  useAcpSessionStore.setState({ sessions: new Map() });
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('AcpTranscript', () => {

  it('renders user and assistant turns', () => {
    const turns: AcpTurn[] = [
      makeTurn({ id: 'u1', role: 'user', contentText: 'Hello' }),
      makeTurn({ id: 'a1', role: 'assistant', contentText: 'Hi there' }),
    ];
    const { container, root } = render(<AcpTranscript turns={turns} activeTurnId={null} />);
    expect(container.querySelector('[data-testid="user-turn"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-turn"]')).not.toBeNull();
    cleanup(root, container);
  });

  it('shows activity indicator for an active thinking turn', () => {
    const turns: AcpTurn[] = [makeTurn({ id: 'a1', role: 'assistant', status: 'thinking' })];
    const { container, root } = render(<AcpTranscript turns={turns} activeTurnId="a1" />);
    expect(container.querySelector('[data-testid="activity-indicator"]')).not.toBeNull();
    cleanup(root, container);
  });

  it('renders a permission request card and sends the selected response', async () => {
    useAcpSessionStore.getState().startUserTurn('NextPert', 's1', 'Run dir');
    useAcpSessionStore.getState().startAssistantTurn('NextPert', 's1');
    useAcpSessionStore.getState().applyEvent({
      agent: 'NextPert',
      sessionId: 's1',
      update: {
        sessionUpdate: 'permission_request',
        sessionId: 's1',
        requestId: 7,
        options: [
          { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
          { optionId: 'approve_for_session', name: 'Approve for session', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
        toolCall: {
          toolCallId: 'tc1',
          title: 'Shell: dir',
          status: 'in_progress',
          content: [],
        },
      },
    });

    const session = useAcpSessionStore.getState().getSession('NextPert')!;
    const { container, root } = render(
      <AcpTranscript
        turns={session.turns}
        activeTurnId={session.activeTurnId}
      />,
    );

    expect(container.querySelector('[data-testid="permission-request-card"]')).not.toBeNull();
    expect(container.textContent).toContain('Permission required');
    expect(container.textContent).toContain('Shell: dir');

    const approveBtn = container.querySelector('[data-testid="permission-option-approve"]') as HTMLButtonElement;
    expect(approveBtn).not.toBeNull();

    act(() => {
      approveBtn.click();
    });

    expect(mockSendAcpPermissionResponse).toHaveBeenCalledWith({
      agent: 'NextPert',
      sessionId: 's1',
      permissionRequestId: 7,
      outcome: 'selected',
      optionId: 'approve',
    });

    await act(async () => Promise.resolve());
    expect(useAcpSessionStore.getState().getSession('NextPert')?.pendingPermission).toBeUndefined();

    cleanup(root, container);
  });

  it('sends a reject permission response and clears the request', async () => {
    useAcpSessionStore.getState().startUserTurn('NextPert', 's1', 'Run dir');
    useAcpSessionStore.getState().startAssistantTurn('NextPert', 's1');
    useAcpSessionStore.getState().applyEvent({
      agent: 'NextPert',
      sessionId: 's1',
      update: {
        sessionUpdate: 'permission_request',
        sessionId: 's1',
        requestId: 8,
        options: [
          { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
        toolCall: {
          toolCallId: 'tc1',
          title: 'Shell: dir',
          status: 'in_progress',
          content: [],
        },
      },
    });

    const session = useAcpSessionStore.getState().getSession('NextPert')!;
    const { container, root } = render(
      <AcpTranscript turns={session.turns} activeTurnId={session.activeTurnId} />,
    );

    const rejectBtn = container.querySelector('[data-testid="permission-option-reject"]') as HTMLButtonElement;
    act(() => {
      rejectBtn.click();
    });

    expect(mockSendAcpPermissionResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'NextPert',
        sessionId: 's1',
        permissionRequestId: 8,
        outcome: 'selected',
        optionId: 'reject',
      }),
    );

    await act(async () => Promise.resolve());
    expect(useAcpSessionStore.getState().getSession('NextPert')?.pendingPermission).toBeUndefined();

    cleanup(root, container);
  });
});

describe('AssistantTurn', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders thinking block and content', () => {
    const turn = makeTurn({
      thinking: 'I should help.',
      contentText: 'Here is the answer.',
    });
    const { container, root } = render(<AssistantTurn turn={turn} />);
    expect(container.textContent).toContain('I should help.');
    expect(container.textContent).toContain('Here is the answer.');
    cleanup(root, container);
  });

  it('renders tool calls', () => {
    const turn = makeTurn({ toolCalls: [makeToolCall()] });
    const { container, root } = render(<AssistantTurn turn={turn} />);
    expect(container.querySelector('[data-testid="tool-call-card"]')).not.toBeNull();
    expect(container.textContent).toContain('Shell: dir');
    cleanup(root, container);
  });

  it('renders thinking as main answer when content is empty', () => {
    const turn = makeTurn({
      thinking: 'I should help.',
      contentText: '',
    });
    const { container, root } = render(<AssistantTurn turn={turn} />);
    expect(container.textContent).toContain('I should help.');
    cleanup(root, container);
  });
});

describe('UserTurn', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders user text', () => {
    const turn = makeTurn({ role: 'user', contentText: 'Do this' });
    const { container, root } = render(<UserTurn turn={turn} />);
    expect(container.textContent).toContain('Do this');
    cleanup(root, container);
  });
});

describe('ToolCallCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('expands to show tool content', () => {
    const toolCall = makeToolCall();
    const { container, root } = render(<ToolCallCard toolCall={toolCall} />);
    expect(container.textContent).toContain('Shell: dir');
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    act(() => {
      button?.click();
    });
    expect(container.textContent).toContain('{"command":"dir"}');
    cleanup(root, container);
  });
});
