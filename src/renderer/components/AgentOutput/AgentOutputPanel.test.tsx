import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

import { AgentOutputPanel } from './AgentOutputPanel';
import { useAgentOutputStore } from '../../stores/agentOutputStore';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';

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

beforeEach(() => {
  useAgentOutputStore.setState({ lines: [], paused: false, selectedAgent: null });
  useAppStore.setState({
    agents: [],
    settings: { showThinking: true } as any,
  });
  useProjectStore.setState({
    activeProject: null,
    currentProjectTeam: [],
  });
});

describe('AgentOutputPanel', () => {
  it('renders the output stream for all agents by default', () => {
    useAgentOutputStore.setState({
      lines: [
        { agent: 'BAPert', line: 'Planning...', ts: new Date().toISOString() },
        { agent: 'NextPert-Scout', line: 'Found 3 files', ts: new Date().toISOString() },
      ],
    });

    const { container, root } = render(<AgentOutputPanel isOpen onClose={() => {}} />);
    expect(container.textContent).toContain('Planning...');
    expect(container.textContent).toContain('Found 3 files');
    cleanup(root, container);
  });


  it('uses activeProject.runtime_choice as the provider authority, ignoring stale agent.provider', () => {
    useProjectStore.setState({
      activeProject: {
        id: 1,
        name: 'acp-desktop',
        runtime_choice: 'kimi',
      } as any,
    });
    useAppStore.setState({
      agents: [
        { id: 'a1', name: 'NextPert-Scout', provider: 'claude' } as any,
      ],
    });
    useAgentOutputStore.setState({
      lines: [
        { agent: 'NextPert-Scout', line: 'refactor complete', ts: new Date().toISOString() },
      ],
    });

    const { container, root } = render(<AgentOutputPanel isOpen onClose={() => {}} />);

    // Provider badge on the output line should read "kimi", not the stale "claude".
    expect(container.textContent).toContain('Kimi');
    expect(container.textContent).not.toContain('Claude');
    cleanup(root, container);
  });

  it('falls back to agent.provider when no project runtime is available', () => {
    useAppStore.setState({
      agents: [
        { id: 'a1', name: 'DotNetPert', provider: 'claude' } as any,
      ],
    });
    useAgentOutputStore.setState({
      lines: [
        { agent: 'DotNetPert', line: 'build succeeded', ts: new Date().toISOString() },
      ],
    });

    const { container, root } = render(<AgentOutputPanel isOpen onClose={() => {}} />);
    expect(container.textContent).toContain('Claude');
    cleanup(root, container);
  });

  it('renders live thinking as a compact inline indicator instead of prose', () => {
    useAgentOutputStore.setState({
      lines: [
        { agent: 'BAPert', line: 'Analyzing context...', thinking: 'step one', thinkingLive: true, ts: new Date().toISOString() },
      ],
    });

    const { container, root } = render(<AgentOutputPanel isOpen onClose={() => {}} />);
    expect(container.textContent).toContain('Analyzing context...');
    expect(container.querySelector('[data-testid="thinking-live"]')).not.toBeNull();
    cleanup(root, container);
  });

  it('renders code-change blocks as structured cards in the side panel', () => {
    useAgentOutputStore.setState({
      lines: [
        {
          agent: 'NextPert-Scout',
          line: 'Modified: App.tsx',
          ts: new Date().toISOString(),
          codeChange: {
            filePath: 'App.tsx',
            operation: 'modified',
            hunks: [
              {
                lines: [
                  { type: 'context', text: 'const x = 1;' },
                  { type: 'add', text: 'const y = 2;' },
                  { type: 'remove', text: 'const z = 3;' },
                ],
              },
            ],
          },
        },
      ],
    });

    const { container, root } = render(<AgentOutputPanel isOpen onClose={() => {}} />);
    expect(container.textContent).toContain('App.tsx');
    expect(container.textContent).toContain('modified');
    expect(container.textContent).toContain('const y = 2');
    expect(container.textContent).toContain('const z = 3');
    cleanup(root, container);
  });
});
