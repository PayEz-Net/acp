/**
 * Electron Lifecycle Callback Server
 *
 * Express server on random port (40030-40099), 127.0.0.1 only.
 * Receives lifecycle commands from acp-api and executes them via node-pty.
 * Auth: Bearer ACP_LOCAL_SECRET (same secret as acp-api).
 */

import http from 'http';
import { spawnAgent, killTerminal, resizeTerminal, getTerminalByAgent, getActiveTerminals, setOnPtyExit } from './pty';
import { getLocalSecret } from './api-server';

let server: http.Server | null = null;
let callbackPort: number | null = null;

const PORT_RANGE_START = 40030;
const PORT_RANGE_END = 40099;

/** Get the callback port (set after server starts) */
export function getCallbackPort(): number | null {
  return callbackPort;
}

/** Verify Bearer token */
function isAuthorized(req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  const secret = getLocalSecret();
  return !!secret && token === secret;
}

/** Parse JSON body from request */
function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Send JSON response */
function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Try to listen on a port in the range */
function tryListen(srv: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => resolve(true));
  });
}

/**
 * Start the lifecycle callback server.
 * Must be called BEFORE startApiServer so the port can be passed via env.
 */
export async function startLifecycleServer(): Promise<number | null> {
  server = http.createServer(async (req, res) => {
    // CORS for localhost
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:40020');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Auth check (skip health)
    const url = req.url || '';
    if (url !== '/health' && !isAuthorized(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    try {
      if (url === '/health' && req.method === 'GET') {
        sendJson(res, 200, { status: 'ok', port: callbackPort });
        return;
      }

      if (url === '/internal/pty/spawn' && req.method === 'POST') {
        const body = await parseBody(req);
        const agentName = body.agentName as string;
        const workDir = (body.workDir as string) || 'E:\\Repos';
        if (!agentName) {
          sendJson(res, 400, { error: 'agentName required' });
          return;
        }
        // Check if agent already has a terminal
        const existing = getTerminalByAgent(agentName);
        if (existing) {
          sendJson(res, 409, { error: 'Agent already running', terminalId: existing.id });
          return;
        }
        const terminalId = spawnAgent(agentName, workDir);
        console.log(`[Lifecycle] Spawned ${agentName}: ${terminalId}`);
        sendJson(res, 200, { terminalId, status: 'spawning' });
        return;
      }

      if (url === '/internal/pty/kill' && req.method === 'POST') {
        const body = await parseBody(req);
        const terminalId = body.terminalId as string;
        const agentName = body.agentName as string;
        // Kill by terminalId or by agentName
        if (terminalId) {
          const ok = killTerminal(terminalId);
          sendJson(res, ok ? 200 : 404, ok ? { status: 'killed' } : { error: 'Terminal not found' });
        } else if (agentName) {
          const t = getTerminalByAgent(agentName);
          if (t) {
            killTerminal(t.id);
            sendJson(res, 200, { status: 'killed', terminalId: t.id });
          } else {
            sendJson(res, 404, { error: 'Agent not running' });
          }
        } else {
          sendJson(res, 400, { error: 'terminalId or agentName required' });
        }
        return;
      }

      if (url === '/internal/pty/resize' && req.method === 'POST') {
        const body = await parseBody(req);
        const terminalId = body.terminalId as string;
        const cols = body.cols as number;
        const rows = body.rows as number;
        if (!terminalId || !cols || !rows) {
          sendJson(res, 400, { error: 'terminalId, cols, rows required' });
          return;
        }
        const ok = resizeTerminal(terminalId, cols, rows);
        sendJson(res, ok ? 200 : 404, ok ? { status: 'resized' } : { error: 'Terminal not found' });
        return;
      }

      if (url === '/internal/pty/list' && req.method === 'GET') {
        sendJson(res, 200, { terminals: getActiveTerminals() });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[Lifecycle] Request error:', err);
      sendJson(res, 500, { error: 'Internal error' });
    }
  });

  // Find an available port in range
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await tryListen(server, port)) {
      callbackPort = port;
      console.log(`[Lifecycle] Callback server listening on 127.0.0.1:${port}`);

      // Setup PTY exit reporting to acp-api
      setupExitReporting();

      return port;
    }
  }

  console.error('[Lifecycle] Failed to bind to any port in range 40030-40099');
  server = null;
  return null;
}

/** Stop the lifecycle server */
export function stopLifecycleServer(): void {
  if (server) {
    console.log('[Lifecycle] Stopping callback server');
    server.close();
    server = null;
    callbackPort = null;
  }
}

/**
 * Task 2: PTY exit reporting — notify acp-api when a PTY exits.
 */
function setupExitReporting() {
  setOnPtyExit((agentName, terminalId, exitCode) => {
    const secret = getLocalSecret();
    if (!secret) return;

    const body = JSON.stringify({ agentName, terminalId, exitCode });
    const options = {
      hostname: '127.0.0.1',
      port: 3001,
      path: '/internal/pty/exit',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secret}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      console.log(`[Lifecycle] Exit reported for ${agentName} (code=${exitCode}): ${res.statusCode}`);
    });
    req.on('error', (err) => {
      console.error(`[Lifecycle] Failed to report exit for ${agentName}:`, err.message);
    });
    req.write(body);
    req.end();
  });
}
