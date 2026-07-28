import { describe, it, expect, beforeEach } from 'vitest';
import { useAgentOutputStore, isFrameBackedTerminal, markFrameBackedTerminal, unmarkFrameBackedTerminal } from './agentOutputStore';

function makeLine(agent: string, line: string, overrides: Record<string, unknown> = {}) {
  return {
    agent,
    terminal_id: 't1',
    line,
    ts: new Date().toISOString(),
    ...overrides,
  };
}

describe('agentOutputStore', () => {
  beforeEach(() => {
    useAgentOutputStore.setState({ lines: [], frames: {}, paused: false, selectedAgent: null });
  });

  it('assigns stable ids to lines added via addLine', () => {
    useAgentOutputStore.getState().addLine(makeLine('NextPert', 'hello'));
    const lines = useAgentOutputStore.getState().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toMatch(/^line-/);
    expect(lines[0].line).toBe('hello');
  });

  it('assigns stable ids to lines added via addLines', () => {
    useAgentOutputStore.getState().addLines([
      makeLine('NextPert', 'one'),
      makeLine('NextPert', 'two'),
    ]);
    const lines = useAgentOutputStore.getState().lines;
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.id)).size).toBe(2);
  });

  it('batches a 100-line burst into the buffer in under 50 ms', () => {
    const burst = Array.from({ length: 100 }, (_, i) => makeLine('NextPert', `line ${i}`));
    const start = performance.now();
    useAgentOutputStore.getState().addLines(burst);
    const duration = performance.now() - start;
    const lines = useAgentOutputStore.getState().lines;
    expect(lines).toHaveLength(100);
    expect(lines[0].line).toBe('line 0');
    expect(lines[99].line).toBe('line 99');
    expect(duration).toBeLessThan(50);
  });

  it('replaces the previous live-thinking placeholder for the same agent', () => {
    useAgentOutputStore.getState().addLine(makeLine('NextPert', 'Thinking...', { thinkingLive: true }));
    useAgentOutputStore.getState().addLine(makeLine('NextPert', 'Still thinking...', { thinkingLive: true }));
    const lines = useAgentOutputStore.getState().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toBe('Still thinking...');
  });

  it('replaces a live-thinking placeholder with the final answer line', () => {
    useAgentOutputStore.getState().addLine(makeLine('NextPert', 'Thinking...', { thinkingLive: true }));
    useAgentOutputStore.getState().addLine(makeLine('NextPert', 'Here is the answer'));
    const lines = useAgentOutputStore.getState().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toBe('Here is the answer');
    expect(lines[0].thinkingLive).toBeFalsy();
  });

  it('prunes the buffer to maxLines', () => {
    useAgentOutputStore.getState().setMaxLines(100);
    const burst = Array.from({ length: 150 }, (_, i) => makeLine('NextPert', `line ${i}`));
    useAgentOutputStore.getState().addLines(burst);
    const lines = useAgentOutputStore.getState().lines;
    expect(lines).toHaveLength(100);
    expect(lines[0].line).toBe('line 50');
    expect(lines[99].line).toBe('line 149');
  });

  it('drops empty and whitespace-only lines from addLine', () => {
    useAgentOutputStore.getState().addLine(makeLine('NextPert', ''));
    useAgentOutputStore.getState().addLine(makeLine('NextPert', '   '));
    useAgentOutputStore.getState().addLine(makeLine('NextPert', '\t\n'));
    useAgentOutputStore.getState().addLine(makeLine('NextPert', 'real'));
    const lines = useAgentOutputStore.getState().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toBe('real');
  });

  it('drops empty and whitespace-only lines from addLines', () => {
    useAgentOutputStore.getState().addLines([
      makeLine('NextPert', ''),
      makeLine('NextPert', '   '),
      makeLine('NextPert', 'first'),
      makeLine('NextPert', '\t'),
      makeLine('NextPert', 'second'),
    ]);
    const lines = useAgentOutputStore.getState().lines;
    expect(lines).toHaveLength(2);
    expect(lines[0].line).toBe('first');
    expect(lines[1].line).toBe('second');
  });

  it('keeps blank lines that carry thinking content', () => {
    useAgentOutputStore.getState().addLine(makeLine('NextPert', '', { thinking: 'some reasoning' }));
    const lines = useAgentOutputStore.getState().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toBe('');
    expect(lines[0].thinking).toBe('some reasoning');
  });

  it('stores and replaces terminal screen frames', () => {
    useAgentOutputStore.getState().setTerminalScreen('t1', ['line one', 'line two']);
    expect(useAgentOutputStore.getState().frames['t1']).toEqual(['line one', 'line two']);
    useAgentOutputStore.getState().setTerminalScreen('t1', ['repainted']);
    expect(useAgentOutputStore.getState().frames['t1']).toEqual(['repainted']);
  });

  it('clearTerminalHistory drops agent lines for the terminal but keeps user/info', () => {
    const store = useAgentOutputStore.getState();
    store.addLine(makeLine('NextPert', 'agent output'));
    store.addLine(makeLine('NextPert', 'you typed this', { source: 'user' }));
    store.addLine(makeLine('NextPert', 'mail notice', { source: 'info' }));
    store.addLine(makeLine('BAPert', 'other agent', { terminal_id: 't2' }));
    useAgentOutputStore.getState().clearTerminalHistory('t1', 'NextPert');
    const lines = useAgentOutputStore.getState().lines;
    expect(lines.map((l) => l.line)).toEqual(['you typed this', 'mail notice', 'other agent']);
  });

  it('tracks frame-backed terminals for the SSE skip path', () => {
    expect(isFrameBackedTerminal('t1')).toBe(false);
    markFrameBackedTerminal('t1');
    expect(isFrameBackedTerminal('t1')).toBe(true);
    expect(isFrameBackedTerminal(undefined)).toBe(false);
    unmarkFrameBackedTerminal('t1');
    expect(isFrameBackedTerminal('t1')).toBe(false);
  });
});
