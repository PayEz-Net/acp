// Fake `claude -p --input-format stream-json` for ClaudeStreamJsonBridge tests.
// Emits a system/init on startup, then one assistant + result pair per NDJSON
// stdin line, and exits 0 on stdin EOF — the same lifecycle as the real CLI.
// The init event echoes whether the child inherited CLAUDE_CODE_CHILD_SESSION,
// so tests can prove the spawn-env strip from the child's side.
const readline = require('readline');

// Mirror real --resume semantics: a resumed session keeps its id.
const resumeIdx = process.argv.indexOf('--resume');
const SESSION = resumeIdx >= 0 ? process.argv[resumeIdx + 1] : 'fake-fixture-session-0001';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

send({
  type: 'system',
  subtype: 'init',
  session_id: SESSION,
  cwd: process.cwd(),
  child_session_marker: process.env.CLAUDE_CODE_CHILD_SESSION ?? null,
  git_bash_path_kept: process.env.CLAUDE_CODE_GIT_BASH_PATH ?? null,
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let text = '';
  try {
    const turn = JSON.parse(line);
    text = turn.message.content[0].text;
  } catch { /* malformed turn: still answer so tests don't hang */ }
  send({
    type: 'assistant',
    session_id: SESSION,
    message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
  });
  send({ type: 'result', subtype: 'success', session_id: SESSION });
});
rl.on('close', () => process.exit(0));
