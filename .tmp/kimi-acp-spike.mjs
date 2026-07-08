import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const KIMI_BIN = 'C:\\Users\\jon-local\\.local\\bin\\kimi.exe';
const CWD = 'E:\\repos\\acp-desktop';
const PROMPT = 'List the files in the current directory concisely, then stop.';
const TIMEOUT_MS = 30000;

let nextId = 1;
function send(stdin, method, params, id = null) {
  const msg = { jsonrpc: '2.0', method };
  if (id !== null) msg.id = id;
  if (params !== undefined) msg.params = params;
  const line = JSON.stringify(msg) + '\n';
  stdin.write(line);
  process.stdout.write(`[SEND] ${method}\n`);
}

function respond(stdin, id, result) {
  const msg = { jsonrpc: '2.0', id, result };
  const line = JSON.stringify(msg) + '\n';
  stdin.write(line);
  process.stdout.write(`[RESPOND] id=${id}\n`);
}

function notify(stdin, method, params) {
  send(stdin, method, params, null);
}

function request(stdin, method, params) {
  const id = nextId++;
  send(stdin, method, params, id);
  return id;
}

const child = spawn(KIMI_BIN, ['acp'], {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
});

const state = {
  pending: new Map(),
  messages: [],
  sessionId: null,
  promptDone: false,
};

function pushMessage(msg) {
  state.messages.push({ ts: new Date().toISOString(), ...msg });
}

function handleResponse(resp) {
  pushMessage(resp);
  if (resp.id === 1) {
    process.stdout.write(`[INIT] agent=${resp.result?.agentInfo?.name} version=${resp.result?.agentInfo?.version} protocolVersion=${resp.result?.protocolVersion}\n`);
    notify(child.stdin, 'initialized', {});
    const newId = request(child.stdin, 'session/new', { cwd: CWD, mcpServers: [] });
    state.pending.set(newId, 'session/new');
  } else if (state.pending.get(resp.id) === 'session/new') {
    state.sessionId = resp.result?.sessionId;
    process.stdout.write(`[SESSION] ${state.sessionId}\n`);
    state.pending.delete(resp.id);
    const promptId = request(child.stdin, 'session/prompt', {
      sessionId: state.sessionId,
      prompt: [{ type: 'text', text: PROMPT }],
    });
    state.pending.set(promptId, 'session/prompt');
  } else if (state.pending.get(resp.id) === 'session/prompt') {
    process.stdout.write(`[PROMPT DONE] stopReason=${resp.result?.stopReason}\n`);
    state.pending.delete(resp.id);
    state.promptDone = true;
  }
}

function handleRequest(req) {
  pushMessage(req);
  if (req.method === 'session/request_permission') {
    process.stdout.write(`[PERMISSION] ${req.params?.toolCall?.title}\n`);
    respond(child.stdin, req.id, {
      outcome: { selected: { optionId: 'approve', outcome: 'selected' } },
    });
  }
}

function handleNotification(note) {
  pushMessage(note);
  if (note.method === 'session/update') {
    const u = note.params?.update || {};
    const type = u.sessionUpdate || u.type;
    process.stdout.write(`[UPDATE] ${type}\n`);
  }
}

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if ('id' in msg && 'result' in msg) {
        handleResponse(msg);
      } else if ('id' in msg && 'error' in msg) {
        process.stdout.write(`[ERROR] ${line}\n`);
        pushMessage(msg);
      } else if ('method' in msg) {
        if ('id' in msg) handleRequest(msg);
        else handleNotification(msg);
      } else {
        process.stdout.write(`[UNKNOWN] ${line}\n`);
      }
    } catch (e) {
      process.stdout.write(`[PARSE ERROR] ${line}\n`);
    }
  }
});

child.stderr.on('data', (chunk) => {
  process.stdout.write(`[STDERR] ${chunk.toString('utf8')}`);
});

child.on('error', (err) => {
  process.stdout.write(`[SPAWN ERROR] ${err.message}\n`);
});

child.on('exit', (code, signal) => {
  process.stdout.write(`[EXIT] code=${code} signal=${signal}\n`);
  finish();
});

const timeout = setTimeout(() => {
  process.stdout.write('[TIMEOUT] killing child\n');
  child.kill('SIGTERM');
}, TIMEOUT_MS);

function finish() {
  clearTimeout(timeout);
  const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kimi-acp-spike-output.json');
  writeFileSync(outPath, JSON.stringify(state.messages, null, 2));
  process.stdout.write(`[SAVED] ${outPath}\n`);
  process.exit(0);
}

const initId = request(child.stdin, 'initialize', {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
  clientInfo: { name: 'acp-desktop-spike', version: '0.0.1' },
});
state.pending.set(initId, 'initialize');
