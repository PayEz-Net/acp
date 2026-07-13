import { spawn } from 'child_process';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_PATH = path.join(PROJECT_ROOT, '.tmp', 'qapert-screenshot-fac57b0.png');
const PORT = 40030;
const URL = `http://127.0.0.1:${PORT}/qapert-harness.html`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await wait(250);
  }
  throw new Error(`Server did not become ready at ${url}`);
}

async function main() {
  console.log('[QAPert] Starting Vite dev server...');
  const vite = spawn('npx', ['vite', '--port', String(PORT)], {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    shell: true,
  });

  let viteOutput = '';
  vite.stdout.on('data', (d) => { viteOutput += d.toString(); });
  vite.stderr.on('data', (d) => { viteOutput += d.toString(); });

  try {
    await waitForServer(URL);
    console.log('[QAPert] Server ready, opening browser...');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(URL, { waitUntil: 'networkidle' });

    // Wait for the harness to signal readiness.
    await page.waitForSelector('[data-testid="harness-ready"]', { timeout: 10000 });

    // Scroll to bottom so the latest turn is visible.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await wait(300);

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log(`[QAPert] Screenshot saved: ${SCREENSHOT_PATH}`);

    await browser.close();
  } finally {
    vite.kill('SIGTERM');
    await wait(1000);
    if (!vite.killed) vite.kill('SIGKILL');
  }
}

main().catch((err) => {
  console.error('[QAPert] Screenshot run failed:', err);
  console.error(viteOutput);
  process.exit(1);
});
