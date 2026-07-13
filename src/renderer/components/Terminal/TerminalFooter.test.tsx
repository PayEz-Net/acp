import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

import { TerminalFooter } from './TerminalFooter';
import { useAgentStatusStore } from '../../stores/agentStatusStore';
import { useAcpSessionStore } from '../../stores/acpSessionStore';
import type { AgentState } from '@shared/types';

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

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 'a1',
    name: 'Nextpert-Scout',
    status: 'busy',
    provider: 'claude',
    ...overrides,
  } as AgentState;
}

beforeEach(() => {
  useAgentStatusStore.setState({ statuses: {} });
  useAcpSessionStore.setState({ sessions: new Map() });
});

describe('TerminalFooter', () => {
  it('renders the agent status, provider, and path', () => {
    const { container, root } = render(
      <TerminalFooter
        agent={makeAgent()}
        provider="claude"
        repoPath="E:\\repos\\acp-desktop"
        lineCount={42}
        thinkingCount={1}
        contextUsage={33.3}
      />,
    );
    expect(container.textContent).toContain('claude');
    expect(container.textContent).toContain('repos\\acp-desktop');
    expect(container.textContent).toContain('42 lines');
    cleanup(root, container);
  });

  it('renders store-derived model, tokens, context, and composing state', () => {
    useAgentStatusStore.setState({
      statuses: {
        'Nextpert-Scout': {
          model: 'claude-sonnet-4-6',
          tokenUsed: 101900,
          tokenMax: 262100,
          contextUsage: 38.5,
          composing: { duration: '<1s', tokens: 140 },
        },
      },
    });
    const { container, root } = render(
      <TerminalFooter
        agent={makeAgent()}
        provider="claude"
        repoPath="E:\\repos"
        lineCount={10}
        thinkingCount={0}
        contextUsage={0}
      />,
    );
    expect(container.textContent).toContain('claude-sonnet-4-6');
    expect(container.textContent).toContain('101.9k/262.1k');
    expect(container.textContent).toContain('<1s · 140t');
    cleanup(root, container);
  });

  it('shortens long cwd to the last two path segments', () => {
    useAgentStatusStore.setState({
      statuses: {
        'Nextpert-Scout': {
          cwd: 'E:\\repos\\acp-desktop\\src\\renderer\\components',
        },
      },
    });
    const { container, root } = render(
      <TerminalFooter
        agent={makeAgent()}
        provider={null}
        repoPath=""
        lineCount={0}
        thinkingCount={0}
        contextUsage={0}
      />,
    );
    expect(container.textContent).toContain('renderer\\components');
    expect(container.textContent).not.toContain('E:\\repos');
    cleanup(root, container);
  });

  it('falls back to repoPath when store cwd is missing', () => {
    const { container, root } = render(
      <TerminalFooter
        agent={makeAgent()}
        provider={null}
        repoPath="E:\\repos\\fallback"
        lineCount={0}
        thinkingCount={0}
        contextUsage={0}
      />,
    );
    expect(container.textContent).toContain('fallback');
    cleanup(root, container);
  });

  it('shows ACP live status and model from the initialized event', () => {
    useAcpSessionStore.getState().applyEvent({
      agent: 'Nextpert-Scout',
      sessionId: 's1',
      update: {
        sessionUpdate: 'initialized',
        sessionId: 's1',
        capabilities: {},
        agentInfo: { name: 'Kimi Code CLI', version: '1.0.0' },
      },
    });
    useAcpSessionStore.getState().startAssistantTurn('Nextpert-Scout', 's1');
    useAcpSessionStore.getState().applyEvent({
      agent: 'Nextpert-Scout',
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        sessionId: 's1',
        toolCall: {
          toolCallId: 'tc1',
          title: 'Shell: ls',
          status: 'in_progress',
          content: [],
        },
      },
    });

    const agent = makeAgent({ status: 'busy', provider: 'kimi' });
    const { container, root } = render(
      <TerminalFooter
        agent={agent}
        provider="kimi"
        repoPath="E:\\repos\\acp-desktop"
        lineCount={0}
        thinkingCount={0}
        contextUsage={0}
      />,
    );

    expect(container.textContent).toContain('Kimi Code CLI 1.0.0');
    cleanup(root, container);
  });

});
