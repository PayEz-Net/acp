// Fake `claude -p --input-format stream-json` for ClaudeStreamJsonBridge and
// ClaudeStreamJsonTransport tests. Emits a system/init on startup, then one
// assistant + result pair per NDJSON stdin line, and exits 0 on stdin EOF —
// the same lifecycle as the real CLI. The init event echoes whether the child
// inherited CLAUDE_CODE_CHILD_SESSION, so tests can prove the spawn-env strip
// from the child's side.
//
// Extra scripted behaviors (real-CLI semantics, wire-verified 2026-08-14 on
// claude 2.1.231):
// - `--resume BOGUS`        → exit 1 immediately (unknown session id).
// - prompt text `SLOW:*`    → a turn that never finishes on its own; only an
//                             interrupt control_request ends it.
// - prompt text `STREAM:*`  → token-level stream_event deltas followed by the
//                             whole-message assistant echo (the real CLI's
//                             --include-partial-messages behavior).
// - {"type":"control_request", request:{subtype:"interrupt"}} →
//                             control_response, and if a SLOW turn is in
//                             flight, result/error_during_execution (is_error)
//                             — exactly what the real CLI emits when a running
//                             turn is interrupted mid-stream.
const readline = require('readline');

// Mirror real --resume semantics: a resumed session keeps its id.
const resumeIdx = process.argv.indexOf('--resume');
const SESSION = resumeIdx >= 0 ? process.argv[resumeIdx + 1] : 'fake-fixture-session-0001';

if (resumeIdx >= 0 && SESSION === 'BOGUS') {
  process.stderr.write('No conversation found with session ID: BOGUS\n');
  process.exit(1);
}

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

send({
  type: 'system',
  subtype: 'init',
  session_id: SESSION,
  cwd: process.cwd(),
  child_session_marker: process.env.CLAUDE_CODE_CHILD_SESSION ?? null,
  git_bash_path_kept: process.env.CLAUDE_CODE_GIT_BASH_PATH ?? null,
});

let slowTurnPending = false;

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { /* malformed: still answer below */ }

  // Control channel: interrupt a running turn (real CLI answers with a
  // control_response and ends the turn with result/error_during_execution).
  if (parsed && parsed.type === 'control_request') {
    send({
      type: 'control_response',
      session_id: SESSION,
      response: { request_id: parsed.request_id ?? null, subtype: parsed.request?.subtype ?? null },
    });
    if (slowTurnPending) {
      slowTurnPending = false;
      send({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        stop_reason: null,
        session_id: SESSION,
      });
    }
    return;
  }

  let text = '';
  try { text = parsed.message.content[0].text; } catch { /* malformed turn: still answer so tests don't hang */ }

  if (typeof text === 'string' && text.startsWith('SLOW:')) {
    // Never answers on its own; the interrupt branch above settles it.
    slowTurnPending = true;
    return;
  }

  if (typeof text === 'string' && text.startsWith('STREAM:')) {
    const full = `echo:${text.slice('STREAM:'.length)}`;
    // Token-level deltas, then the whole-message echo — the real CLI sends
    // BOTH under --include-partial-messages, and the mapper must not double.
    const half = Math.ceil(full.length / 2);
    send({ type: 'stream_event', session_id: SESSION, event: { type: 'message_start' } });
    send({ type: 'stream_event', session_id: SESSION, event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
    send({ type: 'stream_event', session_id: SESSION, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: full.slice(0, half) } } });
    send({ type: 'stream_event', session_id: SESSION, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: full.slice(half) } } });
    send({ type: 'stream_event', session_id: SESSION, event: { type: 'content_block_stop', index: 0 } });
    send({ type: 'stream_event', session_id: SESSION, event: { type: 'message_stop' } });
    send({
      type: 'assistant',
      session_id: SESSION,
      message: { role: 'assistant', content: [{ type: 'text', text: full }] },
    });
    send({ type: 'result', subtype: 'success', session_id: SESSION });
    return;
  }

  send({
    type: 'assistant',
    session_id: SESSION,
    message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
  });
  send({ type: 'result', subtype: 'success', session_id: SESSION });
});
rl.on('close', () => process.exit(0));
