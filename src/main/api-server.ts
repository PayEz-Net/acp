/**
 * ACP API Server — auto-start/stop with Electron
 *
 * Generates a 256-bit local secret on launch (memory-only, never persisted).
 * Spawns acp-api as a child process with the secret via env var.
 * Polls /health to confirm startup before renderer loads.
 */

import { spawn, ChildProcess } from 'child_process';
import { createConnection } from 'net';
import { randomBytes } from 'crypto';
import path from 'path';
import { getCallbackPort } from './lifecycle-server';

let apiProcess: ChildProcess | null = null;
let localSecret: string | null = null;

const API_PORT = 3001;
const HEALTH_POLL_INTERVAL = 500;
const HEALTH_TIMEOUT = 15_000;

/** Get the local secret (generated fresh each launch) */
export function getLocalSecret(): string | null {
  return localSecret;
}

/** Resolve the acp-api repo path relative to this repo */
function getApiPath(): string {
  const devPath = path.resolve(__dirname, '../../../acp-api');
  const legacyPath = path.resolve(__dirname, '../../../acp');
  try {
    require('fs').accessSync(path.join(devPath, 'api/server.js'));
    return devPath;
  } catch {
    return legacyPath;
  }
}

/** Check if a port is already in use */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection({ port, host: '127.0.0.1' });
    conn.on('connect', () => { conn.destroy(); resolve(true); });
    conn.on('error', () => { resolve(false); });
  });
}

/** Poll GET /health until 200 or timeout */
function waitForHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();

    const check = () => {
      if (Date.now() - start > HEALTH_TIMEOUT) {
        console.log('[ACP-API] Health check timed out after 15s');
        resolve(false);
        return;
      }

      const http = require('http');
      const req = http.get(`http://127.0.0.1:${API_PORT}/health`, (res: { statusCode: number }) => {
        if (res.statusCode === 200) {
          console.log('[ACP-API] Health check passed');
          resolve(true);
        } else {
          setTimeout(check, HEALTH_POLL_INTERVAL);
        }
      });
      req.on('error', () => {
        setTimeout(check, HEALTH_POLL_INTERVAL);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(check, HEALTH_POLL_INTERVAL);
      });
    };

    check();
  });
}

/**
 * Start the API server if not already running.
 * Returns true if backend is healthy, false if timed out or failed.
 */
export async function startApiServer(): Promise<boolean> {
  if (await isPortInUse(API_PORT)) {
    // Port occupied by an external instance we didn't spawn — we can't auth to it.
    // Return false so renderer disables mail (Option C).
    console.log(`[ACP-API] Port ${API_PORT} already in use by external process — cannot authenticate, mail disabled`);
    localSecret = null;
    return false;
  }

  // Generate fresh secret only when WE spawn the instance
  localSecret = randomBytes(32).toString('hex');
  console.log('[ACP-API] Local secret generated (memory-only)');

  const apiPath = getApiPath();
  const serverScript = path.join(apiPath, 'api/server.js');

  console.log(`[ACP-API] Starting: node ${serverScript}`);

  apiProcess = spawn('node', [serverScript], {
    cwd: apiPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ACP_LOCAL_SECRET: localSecret,
      PORT: String(API_PORT),
      ACP_CALLBACK_PORT: String(getCallbackPort() || ''),
    },
  });

  apiProcess.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[ACP-API] ${line}`);
  });

  apiProcess.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.error(`[ACP-API] ${line}`);
  });

  apiProcess.on('exit', (code) => {
    console.log(`[ACP-API] Exited with code ${code}`);
    apiProcess = null;
  });

  return waitForHealth();
}

/** Stop the API server */
export function stopApiServer(): void {
  if (apiProcess) {
    console.log('[ACP-API] Stopping...');
    apiProcess.kill('SIGTERM');
    apiProcess = null;
  }
  localSecret = null;
}
