import { describe, it, expect, vi } from 'vitest';
import { useAgentStatusStore } from './agentStatusStore';

describe('agentStatusStore', () => {
  it('sets and gets status per agent', () => {
    useAgentStatusStore.getState().setStatus('Nextpert-Scout', { contextUsage: 42 });
    expect(useAgentStatusStore.getState().getStatus('Nextpert-Scout').contextUsage).toBe(42);
  });

  it('merges updates without overwriting other fields', () => {
    useAgentStatusStore.getState().setStatus('BAPert', { cwd: 'E:\\repos' });
    useAgentStatusStore.getState().setStatus('BAPert', { tokenUsed: 1000 });
    const status = useAgentStatusStore.getState().getStatus('BAPert');
    expect(status.cwd).toBe('E:\\repos');
    expect(status.tokenUsed).toBe(1000);
  });

  it('clears a single agent', () => {
    useAgentStatusStore.getState().setStatus('QAPert', { contextUsage: 10 });
    useAgentStatusStore.getState().clear('QAPert');
    expect(useAgentStatusStore.getState().getStatus('QAPert').contextUsage).toBeUndefined();
  });

  it('clears all agents', () => {
    useAgentStatusStore.getState().setStatus('DotNetPert', { contextUsage: 10 });
    useAgentStatusStore.getState().clear();
    expect(Object.keys(useAgentStatusStore.getState().statuses).length).toBe(0);
  });

  it('ignores empty agent names', () => {
    const before = Object.keys(useAgentStatusStore.getState().statuses).length;
    useAgentStatusStore.getState().setStatus('', { contextUsage: 99 });
    expect(Object.keys(useAgentStatusStore.getState().statuses).length).toBe(before);
  });

  it('updates lastSeenAt on every setStatus call', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T12:00:00.000Z'));
    useAgentStatusStore.getState().setStatus('Nextpert-Scout', { contextUsage: 10 });
    const first = useAgentStatusStore.getState().getStatus('Nextpert-Scout').lastSeenAt;

    vi.setSystemTime(new Date('2026-07-07T12:00:01.000Z'));
    useAgentStatusStore.getState().setStatus('Nextpert-Scout', { contextUsage: 20 });
    const second = useAgentStatusStore.getState().getStatus('Nextpert-Scout').lastSeenAt;

    expect(first).toBe('2026-07-07T12:00:00.000Z');
    expect(second).toBe('2026-07-07T12:00:01.000Z');
    vi.useRealTimers();
  });
});
