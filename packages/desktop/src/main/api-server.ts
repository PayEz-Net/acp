/**
 * ACP API Server — auto-start/stop with Electron
 *
 * Generates a 256-bit local secret on launch (memory-only, never persisted).
 * Spawns acp-api as a child process with the secret via env var.
 * Polls /health to confirm startup before renderer loads.
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import { createConnection } from 'net';
import { randomBytes } from 'crypto';
import path from 'path';
import { getCallbackPort } from './lifecycle-server';

let apiProcess: ChildProcess | null = null;
let localSecret: string | null = null;
let crashCount = 0;
let intentionalStop = false;
let logBuffer: string[] = [];
const MAX_LOG_LINES = 500;

const API_PORT = 3001;
const HEALTH_POLL_INTERVAL = 500;
const HEALTH_TIMEOUT = 15_000;
const MAX_CRASH_RETRIES = 3;

/** Get captured log lines from acp-api stdout/stderr */
export function getApiLogs(): string[] {
  return logBuffer;
}

/** Notify renderer of backend status changes */
let onBackendStatusChange: ((available: boolean, message?: string) => void) | null = null;
export function setOnBackendStatusChange(cb: typeof onBackendStatusChange) {
  onBackendStatusChange = cb;
}

/** Get the local secret (generated fresh each launch) */
export function getLocalSecret(): string | null {
  return localSecret;
}

/** Resolve the acp-api path — bundled in production, sibling folder in dev */
function getApiPath(): string {
  // Production: bundled in extraResources
  if (require('electron').app.isPackaged) {
    const bundledPath = path.join(process.resourcesPath, 'acp-api');
    try {
      require('fs').accessSync(path.join(bundledPath, 'api/server.js'));
      return bundledPath;
    } catch { /* fall through to dev paths */ }
  }
  // Dev: sibling folder
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
/** Kill any orphaned process on a port (Windows). Returns true if killed. */
function killOrphanOnPort(port: number): boolean {
  try {
    const out = execSync(
      `netstat -ano | findstr ":${port}" | findstr "LISTENING"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const match = out.match(/\s+(\d+)\s*$/m);
    if (match) {
      const pid = parseInt(match[1], 10);
      console.log(`[ACP-API] Killing orphan on port ${port} (PID ${pid})`);
      execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
      return true;
    }
  } catch { /* no listener or kill failed — either way, proceed */ }
  return false;
}

export async function startApiServer(): Promise<boolean> {
  if (await isPortInUse(API_PORT)) {
    console.log(`[ACP-API] Port ${API_PORT} in use — killing orphan from previous session`);
    killOrphanOnPort(API_PORT);
    // Brief wait for port to release
    await new Promise(r => setTimeout(r, 1000));
    if (await isPortInUse(API_PORT)) {
      console.log(`[ACP-API] Port ${API_PORT} still in use after kill — cannot start, mail disabled`);
      localSecret = null;
      return false;
    }
  }

  // Generate fresh secret only when WE spawn the instance
  localSecret = randomBytes(32).toString('hex');
  console.log('[ACP-API] Local secret generated (memory-only)');

  const apiPath = getApiPath();
  const serverScript = path.join(apiPath, 'api/server.js');
  const tsxBin = path.join(apiPath, 'node_modules/.bin/tsx');

  console.log(`[ACP-API] Starting: tsx ${serverScript}`);

  apiProcess = spawn(tsxBin, [serverScript], {
    cwd: apiPath,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ACP_LOCAL_SECRET: localSecret,
      PORT: String(API_PORT),
      ACP_CALLBACK_PORT: String(getCallbackPort() || ''),
      STORAGE_MODE: process.env.STORAGE_MODE || 'vibesql',
    },
  });

  apiProcess.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      console.log(`[ACP-API] ${line}`);
      logBuffer.push(`[out] ${line}`);
      if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
    }
  });

  apiProcess.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      console.error(`[ACP-API] ${line}`);
      logBuffer.push(`[err] ${line}`);
      if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
    }
  });

  apiProcess.on('exit', (code) => {
    console.log(`[ACP-API] Exited with code ${code}`);
    apiProcess = null;

    // Crash recovery: auto-restart on unexpected exit
    if (!intentionalStop && code !== 0) {
      crashCount++;
      console.log(`[ACP-API] Crash #${crashCount}/${MAX_CRASH_RETRIES}`);

      if (crashCount <= MAX_CRASH_RETRIES) {
        onBackendStatusChange?.(false, 'Backend restarting...');
        // Restart with new secret after 2s
        setTimeout(async () => {
          const healthy = await startApiServer();
          onBackendStatusChange?.(healthy, healthy ? undefined : 'Backend restart failed');
        }, 2000);
      } else {
        console.error('[ACP-API] Max crash retries exceeded — Option C (mail disabled)');
        onBackendStatusChange?.(false, 'Backend failed after 3 retries');
      }
    }
  });

  intentionalStop = false;
  crashCount = 0; // Reset on successful start

  return waitForHealth();
}

/** Stop the API server (intentional — no crash recovery) */
export function stopApiServer(): void {
  intentionalStop = true;
  if (apiProcess) {
    console.log('[ACP-API] Stopping...');
    apiProcess.kill('SIGTERM');
    apiProcess = null;
  }
  localSecret = null;
}
