/**
 * WO-G4 — Claude stream-json mapper tests.
 *
 * Every fixture below is VERBATIM from a real `claude` 2.1.220 run captured on
 * 2026-07-29 with:
 *
 *   claude -p --output-format stream-json --input-format stream-json \
 *          --verbose --include-partial-messages
 *
 * They are not invented shapes. If Claude changes the wire format these tests
 * are the tripwire.
 */

import { describe, it, expect } from 'vitest';
import {
  ClaudeStreamJsonMapper,
  NdjsonSplitter,
  encodeUserTurn,
  CLAUDE_STREAM_JSON_ARGS,
  type ClaudeStreamJsonEvent,
} from './claudeStreamJson';

const SESSION = '44efa7e0-30c2-4adc-b2fc-a83a3e686348';

const ev = (o: Record<string, unknown>): ClaudeStreamJsonEvent =>
  ({ session_id: SESSION, ...o }) as ClaudeStreamJsonEvent;

const INIT = ev({
  type: 'system',
  subtype: 'init',
  cwd: 'E:/Repos/acp-desktop',
  tools: ['Bash', 'Read'],
  model: 'claude-sonnet-4-6',
  permissionMode: 'bypassPermissions',
  slash_commands: ['review', 'init'],
  claude_code_version: '2.1.220',
});

const textDelta = (text: string, index = 0) =>
  ev({
    type: 'stream_event',
    event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  });

describe('CLAUDE_STREAM_JSON_ARGS', () => {
  // Regression for the scaffold in providerConfigs.ts, which omitted both and
  // therefore could not have run: --input/--output-format require --print, and
  // token streaming requires --include-partial-messages.
  it('includes -p and --include-partial-messages', () => {
    expect(CLAUDE_STREAM_JSON_ARGS).toContain('-p');
    expect(CLAUDE_STREAM_JSON_ARGS).toContain('--include-partial-messages');
    expect(CLAUDE_STREAM_JSON_ARGS).toContain('stream-json');
  });
});

describe('encodeUserTurn', () => {
  it('emits one NDJSON line Claude accepts on stdin', () => {
    const line = encodeUserTurn('hello');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
  });

  it('escapes newlines and quotes rather than breaking the framing', () => {
    const line = encodeUserTurn('a\nb "quoted"');
    expect(line.split('\n')).toHaveLength(2); // only the trailing terminator
    expect(JSON.parse(line.trim()).message.content[0].text).toBe('a\nb "quoted"');
  });
});

describe('session lifecycle', () => {
  it('maps system/init to initialized and captures the session id', () => {
    const m = new ClaudeStreamJsonMapper();
    const out = m.map(INIT);
    expect(m.getSessionId()).toBe(SESSION);
    expect(out[0]).toMatchObject({
      sessionUpdate: 'initialized',
      sessionId: SESSION,
      agentInfo: { name: 'Claude Code', version: '2.1.220', model: 'claude-sonnet-4-6' },
    });
    expect(out[1]).toMatchObject({ sessionUpdate: 'available_commands_update' });
  });

  it('maps status=requesting to a wait_state so the pane indicator stays honest', () => {
    const m = new ClaudeStreamJsonMapper();
    const out = m.map(ev({ type: 'system', subtype: 'status', status: 'requesting' }));
    expect(out).toEqual([
      {
        sessionUpdate: 'wait_state',
        sessionId: SESSION,
        waitState: { kind: 'awaiting_first_token' },
      },
    ]);
  });

  it('drops hook plumbing and billing telemetry', () => {
    const m = new ClaudeStreamJsonMapper();
    expect(m.map(ev({ type: 'system', subtype: 'hook_started', hook_name: 'x' }))).toEqual([]);
    expect(m.map(ev({ type: 'system', subtype: 'hook_response', exit_code: 0 }))).toEqual([]);
    expect(m.map(ev({ type: 'rate_limit_event', rate_limit_info: {} }))).toEqual([]);
  });

  it('maps result to turn_complete with the model stop reason', () => {
    const m = new ClaudeStreamJsonMapper();
    const out = m.map(
      ev({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' }),
    );
    expect(out).toEqual([
      { sessionUpdate: 'turn_complete', sessionId: SESSION, stopReason: 'end_turn' },
    ]);
  });

  it('surfaces an errored result as error + turn_complete so the turn settles', () => {
    const m = new ClaudeStreamJsonMapper();
    const out = m.map(
      ev({ type: 'result', subtype: 'error', is_error: true, result: 'rate limited' }),
    );
    expect(out[0]).toEqual({ sessionUpdate: 'error', sessionId: SESSION, error: 'rate limited' });
    expect(out[1]).toMatchObject({ sessionUpdate: 'turn_complete' });
  });
});

describe('assistant text', () => {
  it('streams text_delta as agent_message_chunk', () => {
    const m = new ClaudeStreamJsonMapper();
    expect(m.map(textDelta('Hel'))).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        sessionId: SESSION,
        content: { type: 'content', content: { type: 'text', text: 'Hel' } },
      },
    ]);
  });

  it('maps thinking_delta to agent_thought_chunk', () => {
    const m = new ClaudeStreamJsonMapper();
    const out = m.map(
      ev({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'hmm' },
        },
      }),
    );
    expect(out[0]).toMatchObject({ sessionUpdate: 'agent_thought_chunk' });
  });

  it('does NOT re-emit the whole-message echo that follows the deltas', () => {
    // Claude sends deltas AND then a complete `assistant` message with the same
    // text. Mapping both would print every reply twice in the pane.
    const m = new ClaudeStreamJsonMapper();
    m.map(ev({ type: 'stream_event', event: { type: 'message_start' } }));
    m.map(textDelta('OK'));
    const echo = m.map(
      ev({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } }),
    );
    expect(echo).toEqual([]);
  });

  it('DOES emit assistant text when no deltas streamed (partial messages absent)', () => {
    const m = new ClaudeStreamJsonMapper();
    m.map(ev({ type: 'stream_event', event: { type: 'message_start' } }));
    const out = m.map(
      ev({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sessionUpdate: 'agent_message_chunk' });
  });

  it('resets echo suppression between turns', () => {
    const m = new ClaudeStreamJsonMapper();
    m.map(ev({ type: 'stream_event', event: { type: 'message_start' } }));
    m.map(textDelta('turn one'));
    m.map(ev({ type: 'result', subtype: 'success', stop_reason: 'end_turn' }));
    // Second turn arrives without partial deltas — must not stay suppressed.
    m.map(ev({ type: 'stream_event', event: { type: 'message_start' } }));
    const out = m.map(
      ev({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } }),
    );
    expect(out).toHaveLength(1);
  });
});

describe('cancelled mid-turn (BAPert CAUTION 2)', () => {
  // The case the pane actually hits now that ESC works. Cancel kills the child
  // mid-stream, so no `result` ever arrives.
  it('settles the turn so the pane cannot spin forever', () => {
    const m = new ClaudeStreamJsonMapper();
    m.map(INIT);
    m.map(ev({ type: 'stream_event', event: { type: 'message_start' } }));
    m.map(textDelta('I was halfway thro'));
    const out = m.cancelTurn();
    expect(out).toEqual([
      { sessionUpdate: 'turn_complete', sessionId: SESSION, stopReason: 'cancelled' },
    ]);
  });

  it('keeps the partial text already streamed — ESC must not erase work', () => {
    const m = new ClaudeStreamJsonMapper();
    m.map(ev({ type: 'stream_event', event: { type: 'message_start' } }));
    const streamed = m.map(textDelta('partial answer'));
    const settle = m.cancelTurn();
    // Nothing in the cancel path retracts or blanks the streamed chunk.
    expect(streamed).toHaveLength(1);
    expect(settle.every((u) => u.sessionUpdate !== 'agent_message_chunk')).toBe(true);
  });

  it('does not suppress the next turn as an echo after a cancel', () => {
    // The trap: cancel leaves sawTextDelta set, so the NEXT turn's whole
    // message would be mistaken for an echo and the pane would show nothing.
    const m = new ClaudeStreamJsonMapper();
    m.map(ev({ type: 'stream_event', event: { type: 'message_start' } }));
    m.map(textDelta('cut off here'));
    m.cancelTurn();
    m.map(ev({ type: 'stream_event', event: { type: 'message_start' } }));
    const next = m.map(
      ev({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fresh reply' }] } }),
    );
    expect(next).toHaveLength(1);
  });

  it('tolerates a late result arriving after the cancel', () => {
    const m = new ClaudeStreamJsonMapper();
    m.map(INIT);
    m.cancelTurn();
    const late = m.map(ev({ type: 'result', subtype: 'success', stop_reason: 'end_turn' }));
    expect(late).toEqual([
      { sessionUpdate: 'turn_complete', sessionId: SESSION, stopReason: 'end_turn' },
    ]);
  });
});

describe('tool calls', () => {
  const TOOL_ID = 'toolu_01B9t3Ew4W6g7AF8SMg9Gry7';

  const start = ev({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: TOOL_ID, name: 'Bash', input: {} },
    },
  });

  it('opens a tool_call as soon as Claude commits to the tool', () => {
    const m = new ClaudeStreamJsonMapper();
    expect(m.map(start)).toEqual([
      {
        sessionUpdate: 'tool_call',
        sessionId: SESSION,
        toolCall: { toolCallId: TOOL_ID, title: 'Bash', status: 'in_progress', content: [] },
      },
    ]);
  });

  it('drops partial input_json_delta rather than showing broken JSON', () => {
    const m = new ClaudeStreamJsonMapper();
    const out = m.map(
      ev({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"comm' },
        },
      }),
    );
    expect(out).toEqual([]);
  });

  it('updates the call with complete arguments from the assistant message', () => {
    const m = new ClaudeStreamJsonMapper();
    m.map(start);
    const out = m.map(
      ev({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: TOOL_ID, name: 'Bash', input: { command: 'ls -la' } }],
        },
      }),
    );
    expect(out[0]).toMatchObject({ sessionUpdate: 'tool_call_update', toolCall: { status: 'in_progress' } });
    expect((out[0] as { toolCall: { contentText?: string } }).toolCall.contentText).toContain('ls -la');
  });

  it('completes the call from the tool_result, keeping the learned title', () => {
    const m = new ClaudeStreamJsonMapper();
    m.map(start);
    const out = m.map(
      ev({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: TOOL_ID, content: 'total 959' }],
        },
      }),
    );
    expect(out[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCall: { toolCallId: TOOL_ID, title: 'Bash', status: 'completed' },
    });
  });

  it('marks an errored tool_result failed', () => {
    const m = new ClaudeStreamJsonMapper();
    m.map(start);
    const out = m.map(
      ev({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: TOOL_ID, content: 'boom', is_error: true },
          ],
        },
      }),
    );
    expect(out[0]).toMatchObject({ toolCall: { status: 'failed' } });
  });

  it('flattens array-form tool_result content', () => {
    const m = new ClaudeStreamJsonMapper();
    m.map(start);
    const out = m.map(
      ev({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: TOOL_ID,
              content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
            },
          ],
        },
      }),
    );
    expect((out[0] as { toolCall: { contentText?: string } }).toolCall.contentText).toBe(
      'line one\nline two',
    );
  });
});

describe('NdjsonSplitter', () => {
  it('reassembles an event split across chunk boundaries', () => {
    // The failure that makes a structured transport look flaky under load.
    const s = new NdjsonSplitter();
    expect(s.push('{"type":"sys')).toEqual([]);
    expect(s.push('tem","subtype":"init"}\n')).toEqual([
      { type: 'system', subtype: 'init' },
    ]);
  });

  it('returns multiple events from one chunk and holds the partial tail', () => {
    const s = new NdjsonSplitter();
    const out = s.push('{"type":"a"}\n{"type":"b"}\n{"type":"par');
    expect(out.map((e) => e.type)).toEqual(['a', 'b']);
    expect(s.push('tial"}\n').map((e) => e.type)).toEqual(['partial']);
  });

  it('ignores unstructured stdout noise instead of killing the session', () => {
    const s = new NdjsonSplitter();
    expect(s.push('not json at all\n{"type":"ok"}\n').map((e) => e.type)).toEqual(['ok']);
  });
});

describe('A-2 — no TUI chrome can reach the pane', () => {
  // The whole point of WO-G4. Replays a real captured turn and asserts none of
  // the TUI chrome the PTY path leaks is representable in the mapped output.
  const CHROME = ['⏵⏵', 'bypass permissions', 'Transcript saving is off', '─────', 'esc to interrupt'];

  it('produces no chrome from a full real turn', () => {
    const m = new ClaudeStreamJsonMapper();
    const wire: ClaudeStreamJsonEvent[] = [
      ev({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' }),
      ev({ type: 'system', subtype: 'hook_response', exit_code: 0 }),
      INIT,
      ev({ type: 'system', subtype: 'status', status: 'requesting' }),
      ev({ type: 'stream_event', event: { type: 'message_start' } }),
      ev({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      }),
      textDelta('Here are '),
      textDelta('the files.'),
      ev({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Here are the files.' }] },
      }),
      ev({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
      ev({ type: 'stream_event', event: { type: 'message_stop' } }),
      ev({ type: 'rate_limit_event', rate_limit_info: {} }),
      ev({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' }),
    ];

    const updates = wire.flatMap((e) => m.map(e));
    const serialized = JSON.stringify(updates);
    for (const glyph of CHROME) {
      expect(serialized).not.toContain(glyph);
    }

    // And the reply is present exactly once — not duplicated by the echo.
    const text = updates
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => (u as { content: { content: { text: string } } }).content.content.text)
      .join('');
    expect(text).toBe('Here are the files.');
    expect(updates.at(-1)).toMatchObject({ sessionUpdate: 'turn_complete' });
  });
});
