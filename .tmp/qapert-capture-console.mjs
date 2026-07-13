import { spawn } from 'child_process';
import { _electron as electron } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';

const PROJECT_ROOT = path.resolve('..');
const LOG_FILE = path.join(PROJECT_ROOT, '.tmp', 'qapert-fresh-console.log');
const VITE_PORT = 40020;
const VITE_URL = `http://localhost:${VITE_PORT}`;
const STARTUP_TIMEOUT_MS = 45000;
const AFTER_READY_WAIT_MS = 5000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForDevServer(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      http.get(url, (res) => {
        if (res.statusCode === 200 || res.statusCode === 204) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('dev server timeout'));
        setTimeout(tryConnect, 500);
      }).on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('dev server timeout'));
        setTimeout(tryConnect, 500);
      });
    };
    tryConnect();
  });
}

function logLine(line) {
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
}

async function main() {
  fs.writeFileSync(LOG_FILE, '', 'utf8');
  logLine(`[QAPert] Capture started at ${new Date().toISOString()}`);
  logLine(`[QAPert] Project root: ${PROJECT_ROOT}`);

  let vite = null;
  let viteOutput = '';
  let ownsVite = false;

  // Re-use an already-running Vite dev server if present (common during active dev).
  const serverAlreadyRunning = await waitForDevServer(VITE_URL, 3000).then(() => true).catch(() => false);

  if (serverAlreadyRunning) {
    console.log('[QAPert] Existing Vite dev server detected, re-using it');
    logLine('[QAPert] Existing Vite dev server detected, re-using it');
  } else {
    console.log('[QAPert] Starting Vite dev server...');
    vite = spawn('npx', ['vite', '--port', String(VITE_PORT)], {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      shell: true,
    });
    ownsVite = true;

    vite.stdout.on('data', (d) => { viteOutput += d.toString(); });
    vite.stderr.on('data', (d) => { viteOutput += d.toString(); });

    await waitForDevServer(VITE_URL, 30000);
    console.log('[QAPert] Dev server ready, launching Electron...');
    logLine('[QAPert] Dev server ready, launching Electron');
  }

  let app = null;
  const timers = [];

  try {

    app = await electron.launch({
      executablePath: path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [PROJECT_ROOT],
      cwd: PROJECT_ROOT,
      env: { ...process.env, NODE_ENV: 'development' },
    });

    const startupTimer = setTimeout(async () => {
      console.warn('[QAPert] Startup timeout reached, closing Electron');
      logLine('[QAPert] Startup timeout reached, closing Electron');
      try { await app?.close(); } catch {}
    }, STARTUP_TIMEOUT_MS);
    timers.push(startupTimer);

    app.on('window', async (page) => {
      logLine(`[QAPert] Window opened: ${page.url()}`);
      page.on('console', (msg) => {
        const text = `[renderer:${msg.type()}] ${msg.text()}`;
        logLine(text);
        console.log(text);
      });
      page.on('pageerror', (err) => {
        const text = `[renderer:pageerror] ${err.message}`;
        logLine(text);
        console.error(text);
      });
      page.on('requestfailed', (req) => {
        const text = `[renderer:requestfailed] ${req.url()} ${req.failure()?.errorText ?? ''}`;
        logLine(text);
        console.error(text);
      });
    });

    const page = await app.firstWindow();
    logLine(`[QAPert] First window: ${page.url()}`);

    page.on('console', (msg) => {
      const text = `[renderer:${msg.type()}] ${msg.text()}`;
      logLine(text);
      console.log(text);
    });
    page.on('pageerror', (err) => {
      const text = `[renderer:pageerror] ${err.message}`;
      logLine(text);
      console.error(text);
    });
    page.on('requestfailed', (req) => {
      const text = `[renderer:requestfailed] ${req.url()} ${req.failure()?.errorText ?? ''}`;
      logLine(text);
      console.error(text);
    });

    await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
    console.log('[QAPert] DOM content loaded, waiting for settle...');
    logLine('[QAPert] DOM content loaded, waiting for settle');

    await wait(AFTER_READY_WAIT_MS);
    console.log('[QAPert] Settle wait complete, closing Electron...');
    logLine('[QAPert] Settle wait complete, closing Electron');

    await app.close();
    app = null;
  } catch (err) {
    console.error('[QAPert] Capture failed:', err.message);
    logLine(`[QAPert] Capture failed: ${err.message}`);
    if (viteOutput) logLine(`[QAPert] Vite output tail:\n${viteOutput.slice(-4000)}`);
    try { await app?.close(); } catch {}
    throw err;
  } finally {
    timers.forEach(clearTimeout);
    if (ownsVite && vite) {
      console.log('[QAPert] Killing Vite dev server...');
      vite.kill('SIGTERM');
      await wait(1000);
      if (!vite.killed) vite.kill('SIGKILL');
    }
    logLine(`[QAPert] Capture finished at ${new Date().toISOString()}`);
    logLine(`[QAPert] Log saved to: ${LOG_FILE}`);
  }
}

main().catch((err) => {
  console.error('[QAPert] Fatal error:', err);
  process.exit(1);
});
