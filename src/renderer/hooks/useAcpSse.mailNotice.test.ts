/**
 * Wiring tests for routeMailNotice (WO 11517): the live-surface routing in
 * useAcpSse must actually land the notice on the right channel — helper-only
 * coverage would let a refactor regress this silently.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { routeMailNotice } from './useAcpSse';
import { useAppStore } from '../stores/appStore';
import { useProjectStore } from '../stores/projectStore';
import { useAgentOutputStore } from '../stores/agentOutputStore';
import { useAcpSessionStore } from '../stores/acpSessionStore';

const mockInjectAcpMail = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  vi.stubGlobal('electronAPI', { injectAcpMail: mockInjectAcpMail });
  // fetchMailBody hits the local mail API — stub it so the notice carries a
  // deterministic inline body.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { body: 'inline mail body' } }),
  }));
  mockInjectAcpMail.mockClear();
  useAppStore.setState({
    agents: [],
    settings: { agentProvider: 'kimi' } as never,
  });
  useProjectStore.setState({
    activeProject: { id: 7, name: 'proj', runtime_choice: 'kimi' } as never,
    pickerHasStarted: true,
  });
  useAgentOutputStore.setState({ lines: [] });
  useAcpSessionStore.setState({ sessions: new Map() } as never);
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('routeMailNotice wiring (WO 11517)', () => {
  it('pty-echo: a PTY-bridge agent gets the self-instructing notice as an info line', async () => {
    useAppStore.setState({
      agents: [{ id: '1', name: 'NextPert', terminalId: 't-pty' } as never],
    });

    await routeMailNotice('NextPert', 'BAPert', 'WORK ORDER', 9101);

    const lines = useAgentOutputStore.getState().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.source).toBe('info');
    expect(lines[0]?.terminal_id).toBe('t-pty');
    expect(lines[0]?.line).toContain('[ACP Mail] You have a message from BAPert: "WORK ORDER" (id: 9101)');
    expect(lines[0]?.line).toContain('inline mail body');
    expect(lines[0]?.line).toContain('do not wait for the human');
    // No injection on the echo path — the main-side poller/MCP delivers.
    expect(mockInjectAcpMail).not.toHaveBeenCalled();
  });

  it('acp-inject: a live ACP session injects first and echoes only after acceptance', async () => {
    vi.useFakeTimers();
    useAppStore.setState({
      agents: [{ id: '1', name: 'NextPert', terminalId: 't-acp' } as never],
    });
    useAcpSessionStore.getState().applyEvent({
      agent: 'NextPert',
      sessionId: 's-live',
      update: { sessionUpdate: 'initialized', sessionId: 's-live' },
    } as never);

    const noticePromise = routeMailNotice('NextPert', 'BAPert', 'WORK ORDER', 9102);

    // Nothing echoed or injected before the first delivery attempt fires.
    expect(mockInjectAcpMail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await noticePromise;

    expect(mockInjectAcpMail).toHaveBeenCalledTimes(1);
    expect(mockInjectAcpMail).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'NextPert', sessionId: 's-live' }),
    );
    const injectedText = mockInjectAcpMail.mock.calls[0]?.[0]?.text as string;
    expect(injectedText).toContain('inline mail body');

    // Echo landed in the transcript only AFTER the runtime accepted.
    const turns = useAcpSessionStore.getState().sessions.get('NextPert')?.turns ?? [];
    const echo = turns.find((t) => t.contentText.includes('id: 9102'));
    expect(echo).toBeDefined();
    expect(echo?.role).toBe('user');
    // And never through the PTY info-line channel.
    expect(useAgentOutputStore.getState().lines).toHaveLength(0);
  });
});
