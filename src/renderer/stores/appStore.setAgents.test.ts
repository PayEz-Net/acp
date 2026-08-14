import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from './appStore';
import type { AgentConfig } from '../../shared/types';

/**
 * setAgents runs on every team-sync poll, not just at startup. Anything it
 * hardcodes is therefore stamped over live state a few times a minute.
 *
 * The regression these tests exist for: status was a hardcoded 'offline' while
 * terminalId and runtimeProvider beside it were preserved. 'ready' is written
 * exactly once, at spawn, so the first poll after startup flipped the whole
 * roster to 'offline' and nothing ever wrote it back — agents read "offline"
 * for the rest of the session while they were mid-task.
 */

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  id: 'a1',
  name: 'DotNetPert',
  ...over,
} as AgentConfig);

describe('appStore.setAgents — status across team-sync polls', () => {
  beforeEach(() => {
    useAppStore.setState({ agents: [] });
  });

  it('keeps a running agent ready when a poll re-sends the roster', () => {
    useAppStore.getState().setAgents([cfg()]);
    useAppStore.getState().setAgentTerminalId('a1', 't-1');
    useAppStore.getState().updateAgentStatus('a1', 'ready');

    // The poll: same roster, arriving again.
    useAppStore.getState().setAgents([cfg()]);

    expect(useAppStore.getState().agents[0].status).toBe('ready');
    expect(useAppStore.getState().agents[0].terminalId).toBe('t-1');
  });

  it('does not downgrade a busy agent to offline mid-task', () => {
    useAppStore.getState().setAgents([cfg()]);
    useAppStore.getState().setAgentTerminalId('a1', 't-1');
    useAppStore.getState().updateAgentStatus('a1', 'busy');

    useAppStore.getState().setAgents([cfg()]);

    expect(useAppStore.getState().agents[0].status).toBe('busy');
  });

  it('survives repeated polls rather than decaying after the first', () => {
    useAppStore.getState().setAgents([cfg()]);
    useAppStore.getState().setAgentTerminalId('a1', 't-1');
    useAppStore.getState().updateAgentStatus('a1', 'ready');

    for (let i = 0; i < 5; i++) useAppStore.getState().setAgents([cfg()]);

    expect(useAppStore.getState().agents[0].status).toBe('ready');
  });

  it('reports offline for an agent that has never been spawned', () => {
    useAppStore.getState().setAgents([cfg()]);
    expect(useAppStore.getState().agents[0].status).toBe('offline');
  });

  it('keeps a hand-stopped agent offline — stopAgent clears terminalId first', () => {
    useAppStore.getState().setAgents([cfg()]);
    useAppStore.getState().setAgentTerminalId('a1', 't-1');
    useAppStore.getState().updateAgentStatus('a1', 'ready');

    // stopAgent(): clears the terminal binding, then marks offline.
    useAppStore.getState().setAgentTerminalId('a1', undefined as any);
    useAppStore.getState().updateAgentStatus('a1', 'offline');

    useAppStore.getState().setAgents([cfg()]);

    expect(useAppStore.getState().agents[0].status).toBe('offline');
  });

  it('treats an agent new to the roster as offline while preserving its peers', () => {
    useAppStore.getState().setAgents([cfg()]);
    useAppStore.getState().setAgentTerminalId('a1', 't-1');
    useAppStore.getState().updateAgentStatus('a1', 'ready');

    useAppStore.getState().setAgents([cfg(), cfg({ id: 'a2', name: 'QAPert' })]);

    const byId = Object.fromEntries(
      useAppStore.getState().agents.map((a) => [a.id, a.status])
    );
    expect(byId.a1).toBe('ready');
    expect(byId.a2).toBe('offline');
  });
});
