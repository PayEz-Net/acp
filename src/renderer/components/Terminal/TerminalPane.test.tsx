import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { TerminalPane } from './TerminalPane';
import { useAppStore } from '../../stores/appStore';
import { useAgentOutputStore } from '../../stores/agentOutputStore';
import { terminalStreamNormalizer } from '../../lib/terminalStream';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockKillTerminal = vi.fn();
const mockGetLocalSecret = vi.fn().mockResolvedValue('secret');

beforeEach(() => {
  vi.stubGlobal('electronAPI', {
    killTerminal: mockKillTerminal,
    getLocalSecret: mockGetLocalSecret,
    resizeTerminal: vi.fn(),
    writeTerminal: vi.fn(),
    readClipboardText: vi.fn(),
    onTerminalExit: vi.fn(() => () => {}),
    onTerminalData: vi.fn(() => () => {}),
  });
  vi.stubGlobal('fetch', vi.fn());

  useAppStore.setState({
    agents: [],
    activeAgentId: null,
    backendAvailable: true,
  });
  useAgentOutputStore.setState({ lines: [] });
  terminalStreamNormalizer.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

function cleanup(root: Root, container: HTMLElement) {
  act(() => {
    root.unmount();
  });
  document.body.removeChild(container);
}

function makeAgent(overrides: Partial<ReturnType<typeof useAppStore.getState>['agents'][number]> = {}) {
  return {
    id: '1',
    name: 'NextPert',
    displayName: 'NextPert',
    workDir: '',
    status: 'offline' as const,
    color: '#10b981',
    position: 'top-left' as const,
    autoStart: false,
    ...overrides,
  };
}

describe('TerminalPane', () => {
  it('renders agent display name and offline status', () => {
    const agent = makeAgent();
    const { container, root } = render(
      <TerminalPane agent={agent} isFocused={false} onFocus={() => {}} compact />,
    );
    expect(container.textContent).toContain('NextPert');
    expect(container.textContent).toContain('offline');
    cleanup(root, container);
  });

  it('starts the agent when play is clicked', async () => {
    const agent = makeAgent();
    useAppStore.setState({ agents: [agent] });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { terminal_id: 't-123' } }),
    } as Response);

    const { container, root } = render(
      <TerminalPane agent={agent} isFocused={false} onFocus={() => {}} compact />,
    );

    const playButton = container.querySelector('button[title="Start Agent"]');
    expect(playButton).not.toBeNull();

    await act(async () => {
      playButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/lifecycle/agents/NextPert/spawn'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(useAppStore.getState().agents[0].terminalId).toBe('t-123');
    cleanup(root, container);
  });

  it('stops the agent and clears stream state when stop is clicked', async () => {
    const agent = makeAgent({ status: 'ready', terminalId: 't-456' });
    useAppStore.setState({ agents: [agent] });
    useAgentOutputStore.setState({
      lines: [{ agent: 'NextPert', terminal_id: 't-456', line: 'old output', ts: new Date().toISOString() }],
    });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);

    const { container, root } = render(
      <TerminalPane agent={agent} isFocused={false} onFocus={() => {}} compact />,
    );

    const stopButton = container.querySelector('button[title="Stop Agent"]');
    expect(stopButton).not.toBeNull();

    await act(async () => {
      stopButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/lifecycle/agents/NextPert/kill'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockKillTerminal).toHaveBeenCalledWith('t-456');
    expect(useAgentOutputStore.getState().lines).toHaveLength(0);
    expect(useAppStore.getState().agents[0].status).toBe('offline');
    cleanup(root, container);
  });

  it('restarts the agent when restart is clicked', async () => {
    const agent = makeAgent({ status: 'ready', terminalId: 't-456' });
    useAppStore.setState({ agents: [agent] });

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { terminal_id: 't-789' } }),
      } as Response);

    const { container, root } = render(
      <TerminalPane agent={agent} isFocused={false} onFocus={() => {}} compact />,
    );

    const restartButton = container.querySelector('button[title="Restart Agent"]');
    expect(restartButton).not.toBeNull();

    await act(async () => {
      restartButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
    });

    expect(mockKillTerminal).toHaveBeenCalledWith('t-456');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/lifecycle/agents/NextPert/spawn'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(useAppStore.getState().agents[0].terminalId).toBe('t-789');
    cleanup(root, container);
  });
});
