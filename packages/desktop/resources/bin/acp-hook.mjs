#!/usr/bin/env node
// acp-hook — Claude Code hook that registers/deregisters agents with ACP backend.
// Reads hook event JSON from stdin, routes to the appropriate ACP API endpoint.
// Exits 0 on all errors (hook failures must not crash Claude Code).

import { readFileSync } from 'node:fs';

const subcommand = process.argv[2];
if (!subcommand) {
  // No subcommand — nothing to do
  process.exit(0);
}

const agentId = process.env.ACP_AGENT_ID;
const apiUrl = (process.env.ACP_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const surfaceId = process.env.ACP_SURFACE_ID || '';

// Read stdin (Claude Code passes hook event JSON on stdin)
let stdinData = '';
try {
  stdinData = readFileSync(0, 'utf-8');
} catch {
  // stdin may be empty or unavailable — that's fine
}

let event = {};
try {
  if (stdinData.trim()) {
    event = JSON.parse(stdinData);
  }
} catch {
  // Malformed JSON — proceed with empty event
}

// Extract agent name from ACP_AGENT_ID (format: "agent:AgentName")
function agentName() {
  if (!agentId) return '';
  return agentId.startsWith('agent:') ? agentId.slice(6) : agentId;
}

async function post(path, body) {
  const url = `${apiUrl}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

async function run() {
  const name = agentName();
  if (!name) {
    // No agent identity — skip silently
    process.exit(0);
  }

  switch (subcommand) {
    case 'session-start': {
      await post(`/v1/agents/${name}/register`, {
        runtime: event.runtime || 'claude-code',
        adapter: 'cli-hook',
        connectionInfo: {
          surfaceId,
          sessionId: event.sessionId || '',
        },
        capabilities: {},
      });
      break;
    }

    case 'stop': {
      await post(`/v1/agents/${name}/deregister`, {});
      break;
    }

    case 'notification': {
      await post('/v1/notifications', {
        fromAgent: name,
        body: event.message || event.body || JSON.stringify(event),
        subject: event.subject || 'hook-notification',
      });
      break;
    }

    default:
      // Unknown subcommand — exit cleanly for forward compatibility
      break;
  }
}

run().then(() => process.exit(0)).catch(() => process.exit(0));
