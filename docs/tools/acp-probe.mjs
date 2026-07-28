// ACP probe v4: answer session/request_permission exactly like acp-desktop
// ({outcome:{outcome:'selected', optionId}}) and see whether the turn unparks
// and completes against the installed runtime (0.24.2 originally; now the
// locally built 0.27.0+wait-state patch). Logs the RAW request.
// v5 (NextPert): also asserts wait_state frames — the wait-state visibility
// patch makes the adapter emit 'awaiting_first_token' at every step start and
// 'provider_retry' during retry backoff. A patched runtime must emit at least
// one wait_state frame before the turn completes; older runtimes emit none,
// so the assertion doubles as the installed-version check.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const kimi = process.env.KIMI_BIN || 'C:\\Users\\jon-local\\.kimi-code\\bin\\kimi';
const child = spawn(kimi, ['--yolo', 'acp'], {
  env: { ...process.env, TERM: 'dumb', CI: 'true' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
let buf = '';
let sessionId = null;
let promptSent = false;
let promptSentAt = null;
const rawPermissionRequests = [];
const waitStateFrames = [];

const send = (id, method, params) => {
  console.log(`[${ts()}] >>> ${method} id=${id}`);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
};
const respond = (id, result) => {
  console.log(`[${ts()}] >>> RESPOND to id=${id} :: ${JSON.stringify(result)}`);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
};

child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'session/request_permission') {
        rawPermissionRequests.push(line);
        const params = msg.params ?? {};
        const options = params.options ?? [];
        console.log(`[${ts()}] PERMISSION REQUEST id=${msg.id} options=${JSON.stringify(options).slice(0, 400)}`);
        // Replicate acp-desktop autoApprove logic exactly:
        const allowAlways = options.find((o) => o.kind === 'allow_always');
        const allowOnce = options.find((o) => o.kind === 'allow_once');
        const optionId = allowAlways?.optionId ?? allowOnce?.optionId ?? options[0]?.optionId ?? 'reject';
        console.log(`[${ts()}] desktop-logic picks optionId=${optionId}`);
        respond(msg.id, { outcome: { outcome: 'selected', optionId } });
        continue;
      }
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        console.log(`[${ts()}] RESPONSE id=${msg.id}${msg.error ? ' ERROR ' + JSON.stringify(msg.error).slice(0, 150) : ''}`);
        if (msg.id === 2 && msg.result?.sessionId) sessionId = msg.result.sessionId;
        if (msg.id === 3) {
          console.log(`[${ts()}] === TURN COMPLETE stopReason=${msg.result?.stopReason} total=${((Date.now() - promptSentAt) / 1000).toFixed(1)}s`);
          writeFileSync('E:/repos/.tmp/acp-permission-requests.json', JSON.stringify(rawPermissionRequests, null, 2));
          writeFileSync('E:/repos/.tmp/acp-wait-state-frames.json', JSON.stringify(waitStateFrames, null, 2));
          if (waitStateFrames.length === 0) {
            console.log(`[${ts()}] WAIT-STATE ASSERTION FAILED: no wait_state frames arrived — the installed runtime predates the wait-state patch`);
            child.kill();
            process.exit(3);
          }
          console.log(`[${ts()}] WAIT-STATE OK: ${waitStateFrames.length} frame(s) (${[...new Set(waitStateFrames.map((f) => f.kind))].join(', ')})`);
          child.kill();
          process.exit(0);
        }
        continue;
      }
      if (msg.method === 'session/update') {
        const u = msg.params?.update ?? {};
        const kind = u.sessionUpdate ?? '?';
        if (kind === 'wait_state') {
          waitStateFrames.push(u);
          const retry = u.kind === 'provider_retry'
            ? ` attempt ${u.nextAttempt ?? '?'}/${u.maxAttempts ?? '?'} in ${Math.round((u.delayMs ?? 0) / 1000)}s (${u.errorName ?? 'error'})`
            : '';
          console.log(`[${ts()}] WAIT_STATE ${u.kind ?? '?'}${retry}`.slice(0, 180));
          continue;
        }
        let detail = '';
        if (kind === 'tool_call') detail = ` ${u.title ?? ''} [${u.kind ?? ''}]`;
        if (kind === 'tool_call_update') detail = ` status=${u.status ?? '?'}`;
        console.log(`[${ts()}] notify ${kind}${detail}`.slice(0, 180));
      }
    } catch { /* ignore */ }
  }
  if (sessionId && !promptSent) {
    promptSent = true;
    promptSentAt = Date.now();
    send(3, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Use your tools: list the top-level entries of E:\\repos, then read E:\\repos\\acp-desktop\\package.json and report the electron version. Narrate each step.' }],
    });
  }
});

child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s) console.log(`[${ts()}] STDERR :: ${s.slice(0, 160)}`);
});
child.on('exit', (code) => { console.log(`[${ts()}] EXIT code=${code}`); process.exit(0); });

setTimeout(() => send(1, 'initialize', {
  protocolVersion: 1,
  capabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'acp-desktop', version: '1.0.0' },
}), 500);
setTimeout(() => send(2, 'session/new', { cwd: 'E:\\repos\\.tmp', mcpServers: [] }), 2000);

setTimeout(() => {
  console.log(`[${ts()}] TIMEOUT 180s — turn did NOT complete even with desktop-style permission responses`);
  writeFileSync('E:/repos/.tmp/acp-permission-requests.json', JSON.stringify(rawPermissionRequests, null, 2));
  child.kill();
  process.exit(2);
}, 180000);
