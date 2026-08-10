/**
 * These pin the three properties that make the bridge trustworthy, not the
 * happy path:
 *   1. turn structure survives (the thing the PTY feed could never express)
 *   2. a telemetry failure never reaches the caller (never break a turn)
 *   3. skipped updates leave NO sequence hole (so a hole means real loss)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reportPtyOutput = vi.fn();
vi.mock('./ptyOutputReporter', () => ({
  reportPtyOutput: (...args: unknown[]) => reportPtyOutput(...args),
}));

import {
  toRecord,
  bridgeAcpEvent,
  resetStreamState,
  getSkippedCount,
  type StreamRecord,
} from './agentStreamBridge';
import type { AcpSessionUpdate } from '../shared/acpTypes';

const TERM = 'term-1';

/** Records actually handed to the transport, decoded from the JSONL payload. */
function sent(): StreamRecord[] {
  return reportPtyOutput.mock.calls.map(([, , data]) => JSON.parse(String(data)));
}

beforeEach(() => {
  reportPtyOutput.mockReset();
  resetStreamState(TERM);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toRecord — the ACP vocabulary that carries work signal', () => {
  it('keeps turn boundaries, and turn_end carries stopReason', () => {
    expect(toRecord({ sessionUpdate: 'turn_started', sessionId: 's' } as AcpSessionUpdate, 1))
      .toEqual({ kind: 'turn_start', seq: 1 });

    // stopReason is what separates a finished turn from a cancelled one. A turn
    // count without it over-reports work, which is the exact metric at stake.
    expect(toRecord(
      { sessionUpdate: 'turn_complete', sessionId: 's', stopReason: 'end_turn' } as AcpSessionUpdate, 2))
      .toEqual({ kind: 'turn_end', seq: 2, meta: { stopReason: 'end_turn' } });
  });

  it('separates prose from thinking, so a consumer can exclude thinking cheaply', () => {
    const text = toRecord(
      { sessionUpdate: 'agent_message_chunk', sessionId: 's', content: { type: 'text', text: 'hello' } } as any, 1);
    const thought = toRecord(
      { sessionUpdate: 'agent_thought_chunk', sessionId: 's', content: { type: 'text', text: 'hmm' } } as any, 2);

    expect(text).toEqual({ kind: 'text', seq: 1, text: 'hello' });
    expect(thought).toEqual({ kind: 'thought', seq: 2, text: 'hmm' });
  });

  it('captures the tool RESULT, not just that a tool ran', () => {
    const r = toRecord({
      sessionUpdate: 'tool_call_update',
      sessionId: 's',
      toolCall: { toolCallId: 't1', title: 'Read', status: 'completed', content: [], contentText: 'file body' },
    } as any, 1);

    // Recording only the title would be half a record — "a tool ran" with the
    // answer discarded.
    expect(r).toMatchObject({ kind: 'tool_result', text: 'file body' });
  });

  it('captures blocked states — the signal the PTY feed could never express', () => {
    expect(toRecord({ sessionUpdate: 'wait_state', sessionId: 's', waitState: 'awaiting_input' } as any, 1))
      .toMatchObject({ kind: 'wait' });
    expect(toRecord({
      sessionUpdate: 'permission_request', sessionId: 's', requestId: 7, options: [],
      toolCall: { toolCallId: 't', title: 'Write', status: 'pending', content: [] },
    } as any, 2)).toMatchObject({ kind: 'permission', text: 'Write' });
  });

  it('captures errors — a capture that drops failures reports a healthier system than exists', () => {
    expect(toRecord({ sessionUpdate: 'error', error: 'boom' } as AcpSessionUpdate, 1))
      .toEqual({ kind: 'error', seq: 1, text: 'boom' });
  });

  it('skips control-plane chatter', () => {
    for (const u of ['initialized', 'spawn_info', 'prompt_queued', 'queue_cleared', 'available_commands_update']) {
      expect(toRecord({ sessionUpdate: u, sessionId: 's' } as any, 1)).toBeNull();
    }
  });

  it('records that a non-text block happened rather than dropping it silently', () => {
    // A gap is not information; "[image]" is.
    expect(toRecord(
      { sessionUpdate: 'agent_message_chunk', sessionId: 's', content: { type: 'image' } } as any, 1))
      .toEqual({ kind: 'text', seq: 1, text: '[image]' });
  });
});

describe('bridgeAcpEvent — failure semantics', () => {
  it('NEVER throws when the transport throws — a turn must not die for telemetry', () => {
    reportPtyOutput.mockImplementation(() => { throw new Error('transport down'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => bridgeAcpEvent('BAPert', TERM, 'kimi',
      { sessionUpdate: 'turn_started', sessionId: 's' } as AcpSessionUpdate)).not.toThrow();

    // ...but it must not fail SILENTLY either. A quiet drop is how a capture
    // ends up empty for twelve days with nothing saying so.
    expect(warn).toHaveBeenCalled();
  });

  it('numbers records monotonically so a batched, retried transport can be re-ordered', () => {
    for (const u of [
      { sessionUpdate: 'turn_started', sessionId: 's' },
      { sessionUpdate: 'agent_message_chunk', sessionId: 's', content: { type: 'text', text: 'a' } },
      { sessionUpdate: 'turn_complete', sessionId: 's', stopReason: 'end_turn' },
    ]) bridgeAcpEvent('BAPert', TERM, 'kimi', u as any);

    expect(sent().map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(sent().map((r) => r.kind)).toEqual(['turn_start', 'text', 'turn_end']);
  });

  it('leaves NO sequence hole for skipped updates — a hole must mean real loss', () => {
    bridgeAcpEvent('BAPert', TERM, 'kimi', { sessionUpdate: 'turn_started', sessionId: 's' } as any);
    bridgeAcpEvent('BAPert', TERM, 'kimi', { sessionUpdate: 'prompt_queued', sessionId: 's', queueDepth: 1 } as any);
    bridgeAcpEvent('BAPert', TERM, 'kimi', { sessionUpdate: 'turn_complete', sessionId: 's', stopReason: 'x' } as any);

    // If skips consumed sequence numbers, this would be [1, 3] and a consumer
    // could not tell a deliberate skip from a lost record.
    expect(sent().map((r) => r.seq)).toEqual([1, 2]);
    expect(getSkippedCount(TERM)).toBe(1);
  });

  it('tags the provider so a consumer can tell JSONL records from raw PTY bytes', () => {
    bridgeAcpEvent('BAPert', TERM, 'kimi', { sessionUpdate: 'turn_started', sessionId: 's' } as any);
    expect(reportPtyOutput).toHaveBeenCalledWith('BAPert', TERM, expect.any(String), 'kimi');
  });

  it('emits one JSON object per line, so the batcher can concatenate safely', () => {
    bridgeAcpEvent('BAPert', TERM, 'kimi', { sessionUpdate: 'turn_started', sessionId: 's' } as any);
    const [, , data] = reportPtyOutput.mock.calls[0];
    // The transport concatenates chunks; without the newline two records merge
    // into one unparseable line at the far end.
    expect(String(data).endsWith('\n')).toBe(true);
    expect(String(data).trimEnd()).not.toContain('\n');
  });

  it('resetStreamState frees per-terminal state so the maps cannot grow forever', () => {
    bridgeAcpEvent('BAPert', TERM, 'kimi', { sessionUpdate: 'prompt_queued', sessionId: 's', queueDepth: 1 } as any);
    expect(getSkippedCount(TERM)).toBe(1);
    resetStreamState(TERM);
    expect(getSkippedCount(TERM)).toBe(0);
  });
});
