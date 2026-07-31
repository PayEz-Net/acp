#!/usr/bin/env node
/**
 * P0 push timer — nudges the ACP API consolidation team every 10 minutes
 * until the deadline expires.
 *
 * Run via the local acp-api mail proxy. The proxy needs an active IDP session;
 * if the sidecar has been restarted and no one has logged in yet, we skip the
 * mail iteration instead of spamming 401s.
 */

const http = require('http');

const LOCAL_SECRET = process.env.ACP_LOCAL_SECRET || '';
const ACP_API_HOST = process.env.ACP_API_HOST || '127.0.0.1';
const ACP_API_PORT = parseInt(process.env.ACP_API_PORT || '3001', 10);
const TOTAL_MINUTES = parseInt(process.env.PUSH_DEADLINE_MINUTES || '600', 10);
const INTERVAL_MINUTES = parseInt(process.env.PUSH_INTERVAL_MINUTES || '10', 10);
const START_TIME = process.env.PUSH_START_TIME ? parseInt(process.env.PUSH_START_TIME, 10) : Date.now();

function requestJson(path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    let data = null;
    if (body) {
      data = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      {
        hostname: ACP_API_HOST,
        port: ACP_API_PORT,
        path,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sendMail(body) {
  return requestJson('/v1/mail/send', 'POST', body, {
    Authorization: `Bearer ${LOCAL_SECRET}`,
  });
}

async function isAuthenticated() {
  try {
    const res = await requestJson('/v1/auth/status');
    return res.body?.data?.is_authenticated === true;
  } catch {
    return false;
  }
}

function remainingMs() {
  return TOTAL_MINUTES * 60 * 1000 - (Date.now() - START_TIME);
}

function fmtHours(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.ceil((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function pushMessage(elapsedMin, remainingMsValue) {
  const remaining = fmtHours(remainingMsValue);
  const urgency = remainingMsValue < 3600000 ? 'FINAL HOUR — ' : '';
  return {
    from_agent: 'InsightPert',
    to: ['BAPert'],
    cc: ['Aurum', 'DotNetPert', 'QAPert', 'NextPert'],
    subject: `${urgency}P0 push — ${remaining} left on ACP API consolidation`,
    body: `BAPert / team —\n\n${urgency}Deadline check-in. ${remaining} remaining to land the ACP API → Desktop monorepo consolidation.\n\nReply now with:\n- What just completed\n- What is actively being worked\n- Any blockers / who can unblock\n\nNo dead air. Push push push.\n\n— InsightPert (P0 timer)`,
  };
}

async function main() {
  if (!LOCAL_SECRET) {
    console.error('[push-timer] ACP_LOCAL_SECRET is required');
    process.exit(1);
  }

  let iteration = 0;

  console.log(`[push-timer] Starting. Deadline: ${TOTAL_MINUTES} minutes. Interval: ${INTERVAL_MINUTES} minutes. Start: ${new Date(START_TIME).toISOString()}`);

  while (remainingMs() > 0) {
    iteration += 1;
    const rem = remainingMs();
    const elapsedMin = Math.floor((Date.now() - START_TIME) / 60000);

    console.log(`[push-timer] Iteration ${iteration} — elapsed ${elapsedMin} min — remaining ${fmtHours(rem)}`);

    try {
      if (await isAuthenticated()) {
        const result = await sendMail(pushMessage(elapsedMin, rem));
        console.log(`[push-timer] Mail sent — status ${result.status}`, result.body?.success ? '(success)' : `(fail: ${JSON.stringify(result.body)})`);
      } else {
        console.log('[push-timer] No active IDP session — skipping mail this iteration');
      }
    } catch (err) {
      console.error(`[push-timer] Mail error: ${err.message}`);
    }

    const sleepMs = Math.min(INTERVAL_MINUTES * 60000, rem);
    if (sleepMs <= 0) break;
    console.log(`[push-timer] Sleeping ${Math.round(sleepMs / 60000)} min...`);
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  console.log('[push-timer] Deadline reached. Stopping.');
}

main();
