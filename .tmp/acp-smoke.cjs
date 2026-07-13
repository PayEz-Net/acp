const { AcpProcess } = require('../dist/main/acp/AcpProcess');
const { sanitizeAcpDisplayText } = require('../dist/shared/acpSanitize');

const p = new AcpProcess({
  command: 'kimi',
  args: ['acp'],
  cwd: 'E:\\repos\\acp-desktop',
  env: { NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CI: 'true' },
});

let nextId = 1;
let sessionId = null;
let promptIndex = 0;
const prompts = [
  'Say hello briefly.',
  'Read the first 5 lines of README.md and quote the project tagline.',
  'Run "echo smoke-test" and report the exact output.',
];

function send(method, params) {
  const id = nextId++;
  p.request(method, params).then((res) => {
    if (method === 'session/new' && res && res.sessionId) {
      sessionId = res.sessionId;
      console.log('[SMOKE] session', sessionId);
      sendPrompt();
    }
  }).catch((err) => console.error('[SMOKE] request error', method, err.message));
  return id;
}

function sendPrompt() {
  if (promptIndex >= prompts.length) {
    console.log('[SMOKE] all prompts complete');
    setTimeout(() => p.kill(), 500);
    return;
  }
  const text = prompts[promptIndex++];
  console.log(`[SMOKE] prompt ${promptIndex}: ${text}`);
  p.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }).catch(() => {});
}

const chunks = [];

p.on('notification', (method, params, id) => {
  if (method === 'session/request_permission') {
    p.respond(id, { outcome: { outcome: 'selected', optionId: 'approve' } });
    console.log('[SMOKE] approved permission', id);
    return;
  }
  if (method !== 'session/update') return;
  const u = params.update;
  if (u.sessionUpdate === 'turn_complete') {
    console.log('[SMOKE] turn complete; sending next prompt');
    setTimeout(sendPrompt, 200);
    return;
  }
  if (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk') {
    const raw = (u.content && u.content.text) || '';
    const clean = sanitizeAcpDisplayText(raw);
    if (clean.trim()) {
      chunks.push({ type: u.sessionUpdate, raw, clean });
      console.log(`[SMOKE] ${u.sessionUpdate}: ${clean}`);
    }
  }
});

p.on('stderr', (text) => console.log('[SMOKE] stderr', text.slice(0, 200)));
p.on('error', (err) => console.error('[SMOKE] process error', err.message));
p.on('exit', () => {
  console.log('[SMOKE] exit');
  const artifactPatterns = [
    /\d+\s*tokens?\s*[:·]/i,
    /\d+s\s*[·:]\s*\d+\s*tokens?/i,
    /^\s*\d{1,3}:\d{2}(?::\d{2})?\s*$/,
    /^\s*:\d+\s*$/,
  ];
  let foundArtifact = false;
  for (const chunk of chunks) {
    for (const pat of artifactPatterns) {
      if (pat.test(chunk.clean)) {
        console.error('[SMOKE] ARTIFACT DETECTED', chunk.clean);
        foundArtifact = true;
      }
    }
  }
  if (!foundArtifact) console.log('[SMOKE] no artifacts detected');
});

p.start();

setTimeout(() => send('initialize', {
  protocolVersion: 1,
  capabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'smoke', version: '1.0' },
}), 200);

setTimeout(() => send('session/new', { mcpServers: [], cwd: 'E:\\repos\\acp-desktop' }), 1200);
