import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

import { AgentOutputPanel } from './AgentOutputPanel';
import { useAgentOutputStore } from '../../stores/agentOutputStore';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAcpSessionStore } from '../../stores/acpSessionStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverMock {
  private callback: ResizeObserverCallback | null = null;
  observe = vi.fn((target: Element) => {
    if (this.callback) {
      this.callback(
        [
          {
            target,
            contentRect: { width: 600, height: 800, top: 0, left: 0, bottom: 800, right: 600, x: 0, y: 0 },
            borderBoxSize: [{ inlineSize: 600, blockSize: 800 }],
            contentBoxSize: [{ inlineSize: 600, blockSize: 800 }],
            devicePixelContentBoxSize: [{ inlineSize: 600, blockSize: 800 }],
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
  });
  disconnect = vi.fn();
  unobserve = vi.fn();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
}

function render(element: React.ReactElement) {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
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
  vi.unstubAllGlobals();
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
  useAcpSessionStore.setState({ sessions: new Map() });
});

describe('AgentOutputPanel', () => {
  it('renders the output stream for all agents by default', () => {
    useAgentOutputStore.setState({
      lines: [
        { id: 'bapert-1', agent: 'BAPert', line: 'Planning...', ts: new Date().toISOString() },
        { id: 'scout-1', agent: 'NextPert-Scout', line: 'Found 3 files', ts: new Date().toISOString() },
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
        runtime_choice: 'claude',
      } as any,
    });
    useAppStore.setState({
      agents: [
        { id: 'a1', name: 'NextPert-Scout', provider: 'kimi' } as any,
      ],
    });
    useAgentOutputStore.setState({
      lines: [
        { id: 'scout-2', agent: 'NextPert-Scout', line: 'refactor complete', ts: new Date().toISOString() },
      ],
    });

    const { container, root } = render(<AgentOutputPanel isOpen onClose={() => {}} />);

    // Provider badge on the output line should read "claude", not the stale "kimi".
    expect(container.textContent).toContain('Claude');
    expect(container.textContent).not.toContain('Kimi');
    cleanup(root, container);
  });

  it('hides raw Kimi PTY lines and shows a pointer to the terminal pane', () => {
    useProjectStore.setState({
      activeProject: {
        id: 1,
        name: 'acp-desktop',
        runtime_choice: 'kimi',
      } as any,
    });
    useAppStore.setState({
      agents: [
        { id: 'a1', name: 'NextPert-Scout', provider: 'kimi' } as any,
      ],
    });
    useAgentOutputStore.setState({
      lines: [
        { id: 'scout-kimi-1', agent: 'NextPert-Scout', line: 'raw PTY trash', ts: new Date().toISOString() },
      ],
    });

    const { container, root } = render(<AgentOutputPanel isOpen onClose={() => {}} />);

    expect(container.textContent).not.toContain('raw PTY trash');
    expect(container.textContent).toContain('Kimi output is shown in the terminal pane');
    cleanup(root, container);
  });

  it('hides lines for agents with an active ACP session even when provider is unset', () => {
    useAppStore.setState({
      agents: [{ id: 'a1', name: 'NextPert' } as any],
    });
    useAcpSessionStore.setState({
      sessions: new Map([
        ['NextPert', { turns: [], activeTurnId: null, runtimeMode: 'acp', sessionId: 's1' } as any],
      ]),
    });
    useAgentOutputStore.setState({
      lines: [{ id: 'np-pty-1', agent: 'NextPert', line: 'raw PTY/TUI garbage', ts: new Date().toISOString() }],
    });

    const { container, root } = render(<AgentOutputPanel isOpen onClose={() => {}} />);

    expect(container.textContent).not.toContain('raw PTY/TUI garbage');
    expect(container.textContent).toContain('Kimi output is shown in the terminal pane');
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
        { id: 'dotnet-1', agent: 'DotNetPert', line: 'build succeeded', ts: new Date().toISOString() },
      ],
    });

    const { container, root } = render(<AgentOutputPanel isOpen onClose={() => {}} />);
    expect(container.textContent).toContain('Claude');
    cleanup(root, container);
  });

  it('renders live thinking as a compact inline indicator instead of prose', () => {
    useAgentOutputStore.setState({
      lines: [
        { id: 'bapert-2', agent: 'BAPert', line: 'Analyzing context...', thinking: 'step one', thinkingLive: true, ts: new Date().toISOString() },
      ],
    });

    const { container, root } = render(<AgentOutputPanel isOpen onClose={() => {}} />);
    expect(container.textContent).toContain('Analyzing context...');
    expect(container.querySelector('[data-testid="thinking-live"]')).not.toBeNull();
    cleanup(root, container);
  });

  it('renders long paths without break-words so they scroll instead of wrapping mid-token', () => {
    useAgentOutputStore.setState({
      lines: [
        {
          id: 'scout-path-1',
          agent: 'NextPert-Scout',
          line: 'E:\\Repos\\Agents\\NextPert-Scout\\someLongFileNameThatShouldNotBreakMidToken.jpg',
          ts: new Date().toISOString(),
        },
      ],
    });

    const { container, root } = render(<AgentOutputPanel isOpen onClose={() => {}} />);
    const lineSpan = container.querySelector('.whitespace-pre-wrap');
    expect(lineSpan).not.toBeNull();
    expect(lineSpan?.classList.contains('overflow-x-auto')).toBe(true);
    expect(lineSpan?.classList.contains('break-words')).toBe(false);
    expect(container.textContent).toContain('someLongFileNameThatShouldNotBreakMidToken.jpg');
    cleanup(root, container);
  });

  it('renders code-change blocks as structured cards in the side panel', () => {
    useAgentOutputStore.setState({
      lines: [
        {
          id: 'scout-3',
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
