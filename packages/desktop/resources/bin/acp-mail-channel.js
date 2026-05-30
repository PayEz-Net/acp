#!/usr/bin/env node
/**
 * ACP Mail Channel Server
 *
 * Minimal Claude Code MCP channel server. One instance is spawned per
 * agent `claude` session via .mcp.json, identified by $ACP_AGENT_NAME.
 * Polls the ACP API inbox for unread mail and emits
 * `notifications/claude/channel` to Claude Code whenever new mail arrives.
 *
 * Wire protocol: stdio JSON-RPC 2.0 (one message per line).
 * Channels spec: https://code.claude.com/docs/en/channels-reference.md
 *
 * Env:
 *   ACP_AGENT_NAME    — required, agent this instance is polling for
 *   ACP_API_URL       — optional, default http://127.0.0.1:3001
 *   ACP_MAIL_POLL_MS  — optional, default 3000
 */

'use strict';

const readline = require('readline');
const http = require('http');

const AGENT = process.env.ACP_AGENT_NAME || process.env.VIBE_AGENT || '';
const API_URL = process.env.ACP_API_URL || 'http://127.0.0.1:3001';
const POLL_MS = parseInt(process.env.ACP_MAIL_POLL_MS || '10000', 10);
const IDP_CLIENT_APP = 'acp_desktop';

function log(msg) {
  // MCP stdio uses stdout for protocol — diagnostics MUST go to stderr.
  process.stderr.write(`[acp-mail-channel${AGENT ? ':' + AGENT : ''}] ${msg}\n`);
}

// NOTE: do NOT exit if AGENT is missing — Claude Code v2.1.108 hangs at
// session startup waiting on the MCP handshake to complete, and exit(1)
// here kills the handshake mid-stream. Instead, complete the handshake
// so Claude Code finishes booting, and skip the poll loop quietly when
// there's no agent identity to poll for.
if (!AGENT) {
  log('ACP_AGENT_NAME not set — running in no-op mode (handshake only, no polling)');
}

// -----------------------------------------------------------------------
// JSON-RPC over stdio
// -----------------------------------------------------------------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

let initialized = false;

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    log(`bad JSON from Claude: ${err.message}`);
    return;
  }

  // initialize — Claude Code handshake. Must respond with capabilities.
  // `experimental.claude/channel` signals we support channel notifications.
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        experimental: { 'claude/channel': {} },
      },
      serverInfo: { name: 'acp-mail-channel', version: '0.1.0' },
    });
    return;
  }

  // After initialize, Claude Code sends notifications/initialized
  // as a fire-and-forget; that's our cue to start polling.
  if (msg.method === 'notifications/initialized') {
    initialized = true;
    if (AGENT) {
      log('initialized — starting inbox poll loop');
      startPolling();
    } else {
      log('initialized — no AGENT set, handshake-only mode, no polling');
    }
    return;
  }

  // Answer the capability probe requests that Claude Code will try
  // (tools/list, resources/list, prompts/list). We don't expose any of
  // these — we only do channel notifications. Return empty.
  if (msg.id !== undefined && typeof msg.method === 'string') {
    reply(msg.id, {
      tools: [],
      resources: [],
      prompts: [],
    });
    return;
  }
});

rl.on('close', () => {
  log('stdin closed — exiting');
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// -----------------------------------------------------------------------
// Channel notification emitter
// -----------------------------------------------------------------------

function emitMailChannel(m) {
  if (!initialized) return;
  const id = m.message_id ?? m.id ?? '?';
  const from = m.from_agent ?? m.from ?? 'unknown';
  const subject = m.subject ?? '(no subject)';
  const importance = m.importance ?? 'normal';

  // `content` is what Claude sees between <channel>...</channel>.
  //
  // Keep it prescriptive: tell Claude *exactly* which curl to run to read
  // the message, because without that Claude falls back to its training
  // knowledge of legacy agent-mail CLI paths that no longer exist here.
  // All mail operations go through the ACP API on 127.0.0.1:3001 with an
  // X-ACP-Agent header — the /agent-mail skill documents the full surface,
  // but a channel push may arrive before that skill is loaded, so the
  // minimum-viable read instruction lives inline here.
  const apiBase = API_URL.replace(/\/$/, '');
  const content =
    `You have new mail from ${from}: "${subject}" (message id ${id}, importance ${importance}).\n\n` +
    `To read the full message, run:\n` +
    `    curl -s "${apiBase}/v1/mail/messages/${id}" -H "X-ACP-Agent: ${AGENT}"\n\n` +
    `All mail operations MUST go through the ACP API on ${apiBase} with the X-ACP-Agent header — ` +
    `never shell out to agent-mail.js or any legacy script. Load the /agent-mail skill for the full ` +
    `API reference (send, reply, mark-read, etc.). After reading, act on the message or reply as appropriate.`;

  notify('notifications/claude/channel', {
    content,
    meta: {
      source: 'agent-mail',
      from: String(from),
      subject: String(subject),
      message_id: String(id),
      importance: String(importance),
    },
  });
  log(`emitted channel notification for message ${id} from ${from}`);
}

// -----------------------------------------------------------------------
// Inbox poller — hits ACP API as the agent, tracks seen message IDs
// -----------------------------------------------------------------------

const seenIds = new Set();
let firstPoll = true;

function fetchInbox() {
  return new Promise((resolve) => {
    const u = new URL(`/v1/mail/inbox/${encodeURIComponent(AGENT)}`, API_URL);
    u.searchParams.set('unread', 'true');
    u.searchParams.set('pageSize', '50');

    const req = http.get(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        headers: {
          'X-ACP-Agent': AGENT,
          'X-IDP-Client-App': IDP_CLIENT_APP,
          'Accept': 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

function extractMessages(response) {
  if (!response) return [];
  // Inbox response has been observed with rows either at `data.messages`
  // or `data` as an array. Accept both shapes defensively.
  const d = response.data ?? response;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.messages)) return d.messages;
  if (Array.isArray(d?.inbox)) return d.inbox;
  if (Array.isArray(d?.rows)) return d.rows;
  return [];
}

async function pollOnce() {
  const res = await fetchInbox();
  if (!res) return;
  const messages = extractMessages(res);
  if (messages.length === 0) {
    firstPoll = false;
    return;
  }

  for (const m of messages) {
    const id = m.message_id ?? m.id;
    if (id === undefined || id === null) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    // First poll records the existing unread set without emitting, so a
    // session starting into a backlog of 10 old unread mails doesn't
    // firehose Claude with 10 simultaneous channel events. Only genuinely
    // *new* mail after this instance started gets pushed.
    if (firstPoll) continue;
    emitMailChannel(m);
  }
  firstPoll = false;
}

function startPolling() {
  // Fire one immediately to establish the baseline.
  pollOnce().catch((err) => log(`first poll failed: ${err.message}`));
  setInterval(() => {
    pollOnce().catch((err) => log(`poll failed: ${err.message}`));
  }, POLL_MS);
}

log(`starting: agent=${AGENT} api=${API_URL} pollMs=${POLL_MS}`);
