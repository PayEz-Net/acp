import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { TerminalPane } from './TerminalPane';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
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
  useProjectStore.setState({ activeProject: null, currentProjectTeam: [] });
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
  it('shows the team runtime in the header provider badge, ignoring stale agent.provider', () => {
    useProjectStore.setState({
      activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
    });
    useAppStore.setState({
      agents: [
        {
          id: '1',
          name: 'NextPert',
          displayName: 'NextPert',
          workDir: '',
          status: 'offline',
          color: '#10b981',
          position: 'top-left',
          autoStart: false,
          provider: 'claude',
        } as any,
      ],
    });

    const agent = makeAgent({ provider: 'claude' });
    const { container, root } = render(<TerminalPane agent={agent} isFocused={false} onFocus={() => {}} compact />);
    expect(container.textContent).toContain('kimi');
    expect(container.textContent).not.toContain('claude');
    cleanup(root, container);
  });

  it('renders agent display name and offline status', () => {
    const agent = makeAgent();
    const { container, root } = render(
      <TerminalPane agent={agent} isFocused={false} onFocus={() => {}} compact />,
    );
    expect(container.textContent).toContain('NextPert');
    expect(container.textContent).toContain('Offline');
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

  it('POSTs effort and model overrides from the team member on manual spawn (WO 11469)', async () => {
    const agent = makeAgent();
    useAppStore.setState({ agents: [agent] });
    useProjectStore.setState({
      activeProject: { id: 7, name: 'proj', runtime_choice: 'kimi' } as any,
      currentProjectTeam: [
        { agent_name: 'NextPert', effort_override: 'high', model_override: 'k3' } as any,
      ],
    });

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

    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) =>
      String(url).includes('/v1/lifecycle/agents/NextPert/spawn'),
    );
    expect(call).toBeDefined();
    const body = JSON.parse(String((call![1] as RequestInit).body));
    expect(body.effort).toBe('high');
    expect(body.model).toBe('k3');
    expect(body.runtime).toBe('kimi');
    cleanup(root, container);
  });

  it('fetches the override roster on demand when it has not landed yet (boot race)', async () => {
    const agent = makeAgent();
    useAppStore.setState({ agents: [agent] });
    useProjectStore.setState({
      activeProject: { id: 7, name: 'proj', runtime_choice: 'kimi' } as any,
      currentProjectTeam: [],
    });
    // The roster arrives only when the pane's backstop fetch runs.
    const fetchSpy = vi
      .spyOn(useProjectStore.getState(), 'fetchCurrentProjectTeam')
      .mockImplementation(async () => {
        useProjectStore.setState({
          currentProjectTeam: [
            { agent_name: 'NextPert', effort_override: null, model_override: 'kimi-for-coding-highspeed' } as any,
          ],
        });
      });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { terminal_id: 't-123' } }),
    } as Response);

    const { container, root } = render(
      <TerminalPane agent={agent} isFocused={false} onFocus={() => {}} compact />,
    );

    const playButton = container.querySelector('button[title="Start Agent"]');
    await act(async () => {
      playButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(fetchSpy).toHaveBeenCalledWith(7);
    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) =>
      String(url).includes('/v1/lifecycle/agents/NextPert/spawn'),
    );
    const body = JSON.parse(String((call![1] as RequestInit).body));
    expect(body.model).toBe('kimi-for-coding-highspeed');
    fetchSpy.mockRestore();
    cleanup(root, container);
  });

  it('stops the agent and clears stream state when stop is clicked', async () => {
    const agent = makeAgent({ status: 'ready', terminalId: 't-456' });
    useAppStore.setState({ agents: [agent] });
    useAgentOutputStore.setState({
      lines: [{ id: 'nextpert-1', agent: 'NextPert', terminal_id: 't-456', line: 'old output', ts: new Date().toISOString() }],
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
