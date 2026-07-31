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
import { VIBE_API_URL, IDP_URL } from './env';

let apiProcess: ChildProcess | null = null;
let localSecret: string | null = null;
let crashCount = 0;
let intentionalStop = false;
let logBuffer: string[] = [];
const MAX_LOG_LINES = 500;

const API_PORT = 3001;

// Decision-C: the non-secret VIBE client identifier (public-safe, like an
// OAuth client_id) is injected into the spawned sidecar env so a clean box
// satisfies acp-api's required('VIBE_CLIENT_ID') WITHOUT softening. The
// VIBE_HMAC_KEY signing secret is NEVER baked or injected — that is
// Decision-C's whole point.
//
// NO tenant is baked in source: the client-id is per-deployment, read from
// ACP_VIBE_CLIENT_ID in the environment (placeholder in .env.example). Each
// deployment runs its own Vibe/IDP instance with its own client; a hosted
// build injects its client-id via build/launch env, never a source literal.
// When unset, the empty value flows through verbatim (never softened, no
// dev-tenant fallback). What acp-api does with it is MODE-CONDITIONAL: in
// hmac/contractors mode it hard-throws on an unset VIBE_CLIENT_ID; the default
// bearer (public) build needs none — the tenant is sourced per-call from the
// token's own client_id claim (requireTokenClientId).
const CONFIGURED_VIBE_CLIENT_ID = process.env.ACP_VIBE_CLIENT_ID || '';
const HEALTH_POLL_INTERVAL = 500;
const HEALTH_TIMEOUT = 15_000;
const MAX_CRASH_RETRIES = 3;

// Deterministic immediate config-failure detection. acp-api's
// required('VIBE_CLIENT_ID') hard-throw is DESIRED (WO C3) — we do NOT make
// it boot. We surface its REAL stderr and STOP retrying a failure that is
// identical every time. NO fallback/default/soften (C1): the surfaced
// message is always the verbatim child stderr (or real exit metadata).
const FAST_EXIT_WINDOW_MS = 5_000;  // exited long before it could be healthy
const MAX_FAST_EXITS = 2;           // N consecutive identical fast exits => deterministic
let spawnStartTime = 0;
let consecutiveFastExits = 0;
let currentStderr = '';

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
      require('fs').accessSync(path.join(bundledPath, 'dist/api/server.js'));
      return bundledPath;
    } catch { /* fall through to dev paths */ }
  }
  // Dev: acp-api now lives as a subfolder inside acp-desktop
  const devPath = path.resolve(__dirname, '../../acp-api');
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
/** Kill any orphaned process on a port. Returns true if killed. */
function killOrphanOnPort(port: number): boolean {
  try {
    if (process.platform === 'win32') {
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
    } else {
      const out = execSync(
        `lsof -ti:${port}`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      const pids = out.split('\n').filter(Boolean);
      for (const pidStr of pids) {
        const pid = parseInt(pidStr, 10);
        if (pid) {
          console.log(`[ACP-API] Killing orphan on port ${port} (PID ${pid})`);
          try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
        }
      }
      return pids.length > 0;
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
  const isPackaged = require('electron').app.isPackaged;

  // Mark spawn time + reset this child's stderr capture (fast-exit detection).
  spawnStartTime = Date.now();
  currentStderr = '';

  if (isPackaged) {
    const serverScript = path.join(apiPath, 'dist/api/server.js');
    console.log(`[ACP-API] Starting: node ${serverScript}`);

    apiProcess = spawn(process.execPath, [serverScript], {
      cwd: apiPath,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ACP_LOCAL_SECRET: localSecret,
        VIBE_CLIENT_ID: CONFIGURED_VIBE_CLIENT_ID,
        // From the single cloud-endpoint authority — packaged → prod
        // vibe-api, decided once, no `||`/dev-93 literal here (this is
        // the c8fadd0 one-off folded into the authority). Set explicitly
        // so the sidecar never falls back to its own dev-93 config.ts.
        VIBE_API_URL,
        IDP_URL,
        // REDIS_URL is optional — the installer handles Redis config
        // separately. Only inject if present; don't crash if missing.
        ...(process.env.REDIS_URL ? { REDIS_URL: process.env.REDIS_URL } : {}),
        PORT: String(API_PORT),
        ACP_CALLBACK_PORT: String(getCallbackPort() || ''),
        STORAGE_MODE: process.env.STORAGE_MODE || 'vibesql',
        NODE_ENV: 'production',
      },
    });
  } else {
    const serverScript = path.join(apiPath, 'api/server.js');
    const tsxBin = path.join(apiPath, 'node_modules/.bin/tsx');
    console.log(`[ACP-API] Starting: tsx ${serverScript}`);

    apiProcess = spawn(tsxBin, ['--no-cache', serverScript], {
      cwd: apiPath,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ACP_LOCAL_SECRET: localSecret,
        VIBE_CLIENT_ID: CONFIGURED_VIBE_CLIENT_ID,
        // Same authority (run-from-source → dev-93), set explicitly so the
        // sidecar's env is authoritative in both modes, never its own `||`.
        VIBE_API_URL,
        IDP_URL,
        ...(process.env.REDIS_URL ? { REDIS_URL: process.env.REDIS_URL } : {}),
        PORT: String(API_PORT),
        ACP_CALLBACK_PORT: String(getCallbackPort() || ''),
        STORAGE_MODE: process.env.STORAGE_MODE || 'vibesql',
        NODE_ENV: process.env.NODE_ENV || 'development',
      },
    });
  }

  apiProcess.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      // Store in buffer but don't spam terminal
      logBuffer.push(`[out] ${line}`);
      if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
      
      // Only show critical lines in terminal
      if (line.includes('Server running') || line.includes('error') || line.includes('Error')
        || line.startsWith('[SignalR]') || line.startsWith('[SSE]')) {
        console.log(`[ACP-API] ${line}`);
      }
    }
  });

  apiProcess.stderr?.on('data', (data: Buffer) => {
    // Keep the verbatim child stderr so a fatal exit can surface the REAL
    // reason (e.g. "VIBE_CLIENT_ID is required but not set …") instead of a
    // generic string. Bounded so it can't grow unbounded.
    currentStderr += data.toString();
    if (currentStderr.length > 8000) currentStderr = currentStderr.slice(-8000);

    const line = data.toString().trim();
    if (line) {
      logBuffer.push(`[err] ${line}`);
      if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();

      // Show all stderr in terminal (debug logs use stderr)
      console.error(`[ACP-API] ${line}`);
    }
  });

  apiProcess.on('exit', (code, signal) => {
    console.log(`[ACP-API] Exited with code ${code}${signal ? ` signal ${signal}` : ''}`);
    apiProcess = null;

    if (intentionalStop) return;
    if (code === 0) return;

    const ranMs = Date.now() - spawnStartTime;
    const fastExit = ranMs < FAST_EXIT_WINDOW_MS; // never came close to healthy
    if (fastExit) { consecutiveFastExits++; } else { consecutiveFastExits = 0; }

    // The surfaced reason is ALWAYS real, never a generic default (C1): the
    // verbatim child stderr, or — only if there was none — the real exit
    // metadata. We never soften, default, or invent a message.
    const stderrText = currentStderr.trim();
    const realDetail = stderrText.length > 0
      ? stderrText
      : `acp-api exited code=${code}${signal ? ` signal=${signal}` : ''} after ${ranMs}ms (no stderr)`;

    // Deterministic immediate config-failure (WO C3): identical instant exits
    // mean retrying will fail identically — e.g. the DESIRED
    // required('VIBE_CLIENT_ID') hard-throw on a box with no creds. Surface
    // the real reason and HALT the respawn loop. We do NOT make it boot.
    if (fastExit && consecutiveFastExits >= MAX_FAST_EXITS) {
      console.error(`[ACP-API] Deterministic fast-exit x${consecutiveFastExits} — halting respawn loop (no retry of an identical failure)`);
      onBackendStatusChange?.(false, `ACP backend can't start: ${realDetail}`);
      return; // loop halts: we deliberately do NOT schedule a respawn
    }

    crashCount++;
    console.log(`[ACP-API] Crash #${crashCount}/${MAX_CRASH_RETRIES}`);

    if (crashCount <= MAX_CRASH_RETRIES) {
      onBackendStatusChange?.(false, 'Backend restarting...');
      // Restart with new secret after 2s
      setTimeout(async () => {
        const healthy = await startApiServer();
        onBackendStatusChange?.(healthy, healthy ? undefined : `ACP backend can't start: ${realDetail}`);
      }, 2000);
    } else {
      console.error('[ACP-API] Max crash retries exceeded — mail disabled');
      onBackendStatusChange?.(false, `ACP backend can't start: ${realDetail}`);
    }
  });

  intentionalStop = false;
  crashCount = 0; // Reset on successful start

  return waitForHealth();
}

/** Stop the API server (intentional — no crash recovery) */
export function stopApiServer(): void {
  // intentionalStop FIRST, before any kill signal: the exit handler checks it
  // (line ~282) and bails without respawning. Setting it after the signal left
  // an R2 race where the exit fired and a fresh acp-api respawned on :3001
  // during shutdown.
  intentionalStop = true;
  // Clean slate for any future legitimate start.
  consecutiveFastExits = 0;
  currentStderr = '';
  const proc = apiProcess;
  apiProcess = null;
  if (proc?.pid) {
    const pid = proc.pid;
    console.log(`[ACP-API] Stopping (pid ${pid})...`);
    try {
      // SIGTERM first so shutdown.ts gets a chance to run its in-process
      // cleanup, THEN a hard tree-kill backstop. Plain SIGTERM is unreliable
      // for an ELECTRON_RUN_AS_NODE child on Windows, and the child is NOT in
      // a job object — without the taskkill it orphans on :3001 after main
      // exits (the zombie-holds-port root cause). taskkill /T reaps any
      // grandchildren too. Off-Windows, SIGTERM is sufficient.
      try { proc.kill('SIGTERM'); } catch { /* fall through to hard kill */ }
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000, stdio: 'ignore' });
      }
    } catch (e) {
      // taskkill exits non-zero if SIGTERM already reaped the pid — that's a
      // success, not an error.
      console.log('[ACP-API] taskkill backstop (pid likely already gone):', (e as Error).message);
    }
  }
  localSecret = null;
}
