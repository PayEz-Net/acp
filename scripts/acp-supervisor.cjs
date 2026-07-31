#!/usr/bin/env node
/**
 * ACP dev:prod supervisor — keeps the app + push timer alive.
 *
 * Runs in a detached screen/tmux or nohup. Every 60s:
 *   - Ensures dev:prod is running in its own screen session
 *   - Extracts the acp-api local secret from the running process
 *   - Ensures the push timer is running with the current secret
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = '/Users/jonranes/Repos/acp-desktop';
const SCREEN_DEVPROD = 'acp-devprod';
const SCREEN_PUSHER = 'acp-pusher';
const PUSH_START_FILE = path.join(REPO, '.push-timer-start');
const PUSHER_SECRET_FILE = '/tmp/acp-pusher-secret';
const CHECK_INTERVAL_MS = 60000;

function isApiHealthy() {
  return new Promise((resolve) => {
    require('http').get('http://127.0.0.1:3001/health', (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return '';
  }
}

function screenExists(name) {
  return sh(`screen -ls ${name}`).includes(name);
}

function startDevProd() {
  console.log('[supervisor] Starting dev:prod screen session...');
  sh(
    `cd "${REPO}" && screen -dmS ${SCREEN_DEVPROD} bash -c 'source "$HOME/.bashrc" && source "$HOME/.nvm/nvm.sh" && nvm use 24 && npm run dev:prod 2>&1 | tee /tmp/acp-devprod.log'`
  );
}

function findAcpApiPid() {
  try {
    const out = execSync('pgrep -f "api/server.js"', { encoding: 'utf8' });
    const pids = out.trim().split('\n').filter(Boolean);
    return pids[0] || null;
  } catch {
    return null;
  }
}

function extractSecret(pid) {
  try {
    const env = execSync(`ps eww ${pid}`, { encoding: 'utf8' });
    const m = env.match(/ACP_LOCAL_SECRET=([a-f0-9]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function getLastPusherSecret() {
  try {
    return fs.readFileSync(PUSHER_SECRET_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function setLastPusherSecret(secret) {
  try {
    fs.writeFileSync(PUSHER_SECRET_FILE, secret);
  } catch (err) {
    console.error('[supervisor] Could not write pusher secret file:', err.message);
  }
}

function stopPusher() {
  if (screenExists(SCREEN_PUSHER)) {
    sh(`screen -S ${SCREEN_PUSHER} -X quit`);
  }
}

function startPusher(secret) {
  console.log('[supervisor] Starting push timer screen session...');
  const startTime = fs.existsSync(PUSH_START_FILE) ? fs.readFileSync(PUSH_START_FILE, 'utf8').trim() : String(Date.now());
  sh(
    `cd "${REPO}" && screen -dmS ${SCREEN_PUSHER} bash -c 'export ACP_LOCAL_SECRET=${secret} && export PUSH_START_TIME=${startTime} && node scripts/push-timer.cjs 2>&1 | tee /tmp/acp-pusher.log'`
  );
  setLastPusherSecret(secret);
}

function ensurePushTimer(secret) {
  if (!secret) return;
  const running = screenExists(SCREEN_PUSHER);
  const lastSecret = getLastPusherSecret();
  if (running && lastSecret === secret) {
    // Pusher is up and has the current secret — leave it alone.
    return;
  }
  if (running) {
    console.log('[supervisor] ACP_LOCAL_SECRET changed — restarting push timer');
    stopPusher();
  }
  startPusher(secret);
}

async function main() {
  console.log('[supervisor] Starting ACP supervisor loop...');
  while (true) {
    try {
      if (!screenExists(SCREEN_DEVPROD)) {
        startDevProd();
      }

      // Wait for acp-api HTTP port to be ready
      let portReady = false;
      for (let i = 0; i < 60 && !portReady; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        portReady = await isApiHealthy();
      }

      // Wait for acp-api to come up
      let secret = null;
      for (let i = 0; i < 30 && !secret; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const pid = findAcpApiPid();
        if (pid) secret = extractSecret(pid);
      }

      if (secret) {
        ensurePushTimer(secret);
      } else {
        console.log('[supervisor] Could not extract acp-api secret yet');
      }
    } catch (err) {
      console.error('[supervisor] Loop error:', err.message);
    }
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

main();
