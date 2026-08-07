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

const mockInjectAcpMail = vi.fn().mockResolvedValue('delivered');

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
  it('pty-echo: a PTY-bridge agent gets NO SSE echo box — pty.ts poller/MCP is the sole notice+delivery path (duplicate box removed, Jon 2026-08-05)', async () => {
    useAppStore.setState({
      agents: [{ id: '1', name: 'NextPert', terminalId: 't-pty' } as never],
    });

    await routeMailNotice('NextPert', 'BAPert', 'WORK ORDER', 9101);

    // The SSE hook no longer paints the redundant "You have a message from" box on
    // the pty-echo route: the main-process poller (pty.ts) already prints the
    // "New message from" chat line and delivers out-of-band. So nothing here.
    expect(useAgentOutputStore.getState().lines).toHaveLength(0);
    // And it still never injects on this route.
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

  it('deferred acp-inject re-drives when the agent goes idle (turn end)', async () => {
    vi.useFakeTimers();
    try {
      useAppStore.setState({
        agents: [{ id: '1', name: 'NextPert', terminalId: 't-acp' } as never],
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's-live',
        update: { sessionUpdate: 'initialized', sessionId: 's-live' },
      } as never);
      // Agent mid-turn: the inject defers (tri-state) and parks the notice.
      useAcpSessionStore.getState().startAssistantTurn('NextPert', 's-live');
      mockInjectAcpMail.mockResolvedValue('deferred');

      void routeMailNotice('NextPert', 'BAPert', 'WORK ORDER', 9103);
      await vi.advanceTimersByTimeAsync(500);
      expect(mockInjectAcpMail).toHaveBeenCalledTimes(1);

      // Turn ends — the parked notice re-drives through the full route.
      mockInjectAcpMail.mockResolvedValue('delivered');
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's-live',
        update: { sessionUpdate: 'turn_complete', sessionId: 's-live', stopReason: 'end_turn' },
      } as never);
      await vi.advanceTimersByTimeAsync(500);
      expect(mockInjectAcpMail).toHaveBeenCalledTimes(2);
    } finally {
      mockInjectAcpMail.mockResolvedValue('delivered');
      vi.useRealTimers();
    }
  });
});
