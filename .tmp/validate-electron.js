const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const SHOT_DIR = path.join('E:', 'Repos', 'Agents', 'NextPert', 'validation-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

function shot(name) {
  return path.join(SHOT_DIR, `${name}.png`);
}

function waitForDevServer(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      http.get(url, (res) => {
        if (res.statusCode === 200) return resolve();
        if (Date.now() - start > timeout) return reject(new Error('dev server timeout'));
        setTimeout(tryConnect, 500);
      }).on('error', () => {
        if (Date.now() - start > timeout) return reject(new Error('dev server timeout'));
        setTimeout(tryConnect, 500);
      });
    };
    tryConnect();
  });
}

(async () => {
  console.log('[validate] waiting for dev server...');
  await waitForDevServer('http://localhost:40020');
  console.log('[validate] dev server ready');

  const app = await electron.launch({
    executablePath: path.join('E:', 'Repos', 'acp-desktop', 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [path.join('E:', 'Repos', 'acp-desktop')],
    cwd: path.join('E:', 'Repos', 'acp-desktop'),
    env: { ...process.env, NODE_ENV: 'development' },
  });

  const page = await app.firstWindow();
  console.log('[validate] window opened');

  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: shot('01-initial'), fullPage: false });
    console.log('[validate] screenshot 01-initial saved');

    await page.waitForTimeout(5000);
    await page.screenshot({ path: shot('02-after-5s'), fullPage: false });
    console.log('[validate] screenshot 02-after-5s saved');

    // Refresh to pick up latest HMR-built code
    await page.reload();
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: shot('03-after-reload'), fullPage: false });
    console.log('[validate] screenshot 03-after-reload saved');

    // Look for terminal panes / agent output panel
    const agentOutputButton = await page.locator('button, [role="button"]').filter({ hasText: /Agent Output|Terminal|Output/i }).first();
    if (await agentOutputButton.isVisible().catch(() => false)) {
      await agentOutputButton.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: shot('04-agent-output'), fullPage: false });
      console.log('[validate] screenshot 04-agent-output saved');
    }
  } catch (e) {
    console.error('[validate] error:', e.message);
    await page.screenshot({ path: shot('error'), fullPage: false });
  } finally {
    await app.close();
    console.log('[validate] app closed');
  }
})();
