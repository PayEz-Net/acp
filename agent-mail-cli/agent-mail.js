#!/usr/bin/env node
/**
 * Shared Agent Mail CLI - Enterprise Auth Edition
 * Location: E:\Repos\Agents\_sharedAgentMailScriptsEnterpriseAuth
 *
 * Usage: node agent-mail.js --agent <name> [--prod|--test] <command> [args]
 *
 * Commands:
 *   inbox                    - Check inbox
 *   read <id>                - Read message by ID
 *   send <to> <subject>      - Send message (use --body-file for body)
 *   agents                   - List all agents
 *
 * Flags:
 *   --agent <name>           - Your agent name (required)
 *   --prod                   - Use production API (api.idealvibe.online)
 *   --test                   - Use test API (10.0.0.220)
 *   --body-file <path>       - Read message body from file (avoids escaping)
 *   --body <text>            - Message body as argument (simple messages only)
 *
 * Examples:
 *   node agent-mail.js --agent BAPert --prod inbox
 *   node agent-mail.js --agent BAPert --test read 42
 *   node agent-mail.js --agent BAPert --prod send NextPert "Status Update" --body-file msg.txt
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Environment configs - credentials to be verified
const ENVIRONMENTS = {
  prod: {
    apiUrl: 'https://api.idealvibe.online/v1/agentmail',
    clientId: 'vibe_b2d2aac0315549d9',
    secretKey: 'KAG7vjumrWhx4CHtPSNcowYzjkbeVZmSitD8xjdZXkw='
  },
  test: {
    apiUrl: 'http://10.0.0.220/v1/agentmail',
    clientId: 'PLACEHOLDER_TEST_CLIENT',
    secretKey: 'PLACEHOLDER_TEST_SECRET'
  }
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    agent: null,
    env: null,
    command: null,
    args: [],
    bodyFile: null,
    body: null,
    all: false,
    read: false,
    sent: false
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--agent' && args[i + 1]) {
      parsed.agent = args[++i];
    } else if (arg === '--prod') {
      parsed.env = 'prod';
    } else if (arg === '--test') {
      parsed.env = 'test';
    } else if (arg === '--body-file' && args[i + 1]) {
      parsed.bodyFile = args[++i];
    } else if (arg === '--body' && args[i + 1]) {
      parsed.body = args[++i];
    } else if (arg === '--all') {
      parsed.all = true;
    } else if (arg === '--read') {
      parsed.read = true;
    } else if (arg === '--sent') {
      parsed.sent = true;
    } else if (!arg.startsWith('--')) {
      if (!parsed.command) {
        parsed.command = arg;
      } else {
        parsed.args.push(arg);
      }
    }
    i++;
  }

  return parsed;
}

function sign(method, urlPath, config) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto.createHmac('sha256', Buffer.from(config.secretKey, 'base64'))
    .update(`${timestamp}|${method}|${urlPath}`)
    .digest('base64');
  return { timestamp, signature };
}

async function apiCall(method, urlPath, config, body = null) {
  const { timestamp, signature } = sign(method, urlPath, config);

  const options = {
    method,
    headers: {
      'X-Vibe-Client-Id': config.clientId,
      'X-Vibe-Timestamp': timestamp,
      'X-Vibe-Signature': signature,
    }
  };

  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['X-Vibe-User-Id'] = '1';
    options.body = JSON.stringify(body);
  }

  const endpoint = urlPath.replace('/v1/agentmail', '');
  const response = await fetch(`${config.apiUrl}${endpoint}`, options);
  return response.json();
}

async function checkInbox(agentName, config, { showAll, showRead, showSent } = {}) {
  if (showSent) {
    const result = await apiCall('GET', `/v1/agentmail/sent/${agentName}`, config);
    if (result.success && result.data?.messages) {
      console.log(`\nSent by ${agentName} (${result.data.messages.length} messages)\n`);
      if (result.data.messages.length === 0) {
        console.log('  No sent messages.');
      } else {
        result.data.messages.forEach(m => {
          const msgId = m.message_id || m.id || '?';
          const to = m.to_agent_display || m.to_agent || m.to || '?';
          console.log(`  [${msgId}] To: ${to}`);
          console.log(`     Subject: ${m.subject}`);
          console.log(`     Date: ${new Date(m.created_at).toLocaleString()}\n`);
        });
      }
    } else {
      console.log('Error:', result.error || result);
    }
    return;
  }

  const result = await apiCall('GET', `/v1/agentmail/inbox/${agentName}`, config);
  if (result.success && result.data?.messages) {
    let messages, label;
    const totalCount = result.data.messages.length;
    if (showAll) {
      messages = result.data.messages;
      label = `${totalCount} messages`;
    } else if (showRead) {
      messages = result.data.messages.filter(m => m.read_at);
      label = `${messages.length} read of ${totalCount} total`;
    } else {
      messages = result.data.messages.filter(m => !m.read_at);
      label = `${messages.length} unread of ${totalCount} total`;
    }
    console.log(`\nInbox for ${agentName} (${label})\n`);
    if (messages.length === 0) {
      const hint = showAll ? '' : showRead ? '' : ' Use --all to see all.';
      console.log('  No messages.' + hint);
    } else {
      messages.forEach(m => {
        const msgId = m.message_id || m.id || '?';
        console.log(`  [${msgId}] From: ${m.from_agent_display || m.from_agent}`);
        console.log(`     Subject: ${m.subject}`);
        console.log(`     Date: ${new Date(m.created_at).toLocaleString()}\n`);
      });
    }
  } else {
    console.log('Error:', result.error || result);
  }
}

async function readMessage(id, agentName, config) {
  const result = await apiCall('GET', `/v1/agentmail/messages/${id}`, config);
  if (result.success && result.data) {
    const m = result.data;
    const fromAgent = m.from_agent_display || m.from_agent;
    // API returns recipient in from_agent field - workaround: if from matches us, show "To: me"
    const toDisplay = agentName;
    console.log('\n' + '='.repeat(60));
    console.log(`From: ${fromAgent}`);
    console.log(`To: ${toDisplay}`);
    console.log(`Subject: ${m.subject}`);
    console.log(`Date: ${new Date(m.created_at).toLocaleString()}`);
    if (m.thread_id) console.log(`Thread: ${m.thread_id}`);
    console.log('='.repeat(60) + '\n');
    console.log(m.body);
    console.log('\n' + '='.repeat(60) + '\n');
  } else {
    console.log('Error:', result.error || result);
  }
}

async function sendMessage(agentName, to, subject, body, config) {
  const result = await apiCall('POST', '/v1/agentmail/send', config, {
    from_agent: agentName,
    to: [to],
    subject,
    body
  });
  if (result.success) {
    console.log(`Message sent to ${to} (ID: ${result.data?.message_id || 'OK'})`);
  } else {
    console.log('Send failed:', result.error || result);
  }
}

async function listAgents(config) {
  const result = await apiCall('GET', '/v1/agentmail/agents', config);
  if (result.success && result.data?.agents) {
    console.log('\nTeam Agents:\n');
    result.data.agents.forEach(a => {
      console.log(`  ${a.name.padEnd(15)} - ${a.role || 'Agent'}`);
    });
    console.log('');
  } else {
    console.log('Error:', result.error || result);
  }
}

function showHelp() {
  console.log(`
Shared Agent Mail CLI - Enterprise Auth Edition

Usage: node agent-mail.js --agent <name> [--prod|--test] <command> [args]

Required:
  --agent <name>       Your agent name (e.g., BAPert, NextPert)
  --prod OR --test     Environment selection

Commands:
  inbox                Check unread messages (default)
  inbox --read         Show read messages
  inbox --sent         Show sent messages
  inbox --all          Show all messages
  read <id>            Read a specific message
  send <to> <subject>  Send a message
  agents               List all registered agents

Send Options:
  --body-file <path>   Read message body from file (recommended)
  --body <text>        Inline body (for short messages)

Examples:
  node agent-mail.js --agent BAPert --prod inbox
  node agent-mail.js --agent BAPert --prod read 123
  node agent-mail.js --agent BAPert --prod send NextPert "Build Ready" --body-file msg.txt
  node agent-mail.js --agent BAPert --prod send QAPert "Quick Note" --body "Tests passed"
  node agent-mail.js --agent BAPert --test agents

Environments:
  --prod    api.idealvibe.online
  --test    10.0.0.220
`);
}

async function main() {
  const parsed = parseArgs();

  // Validate required args
  if (!parsed.agent || !parsed.env || !parsed.command) {
    showHelp();
    if (!parsed.agent) console.log('ERROR: --agent <name> is required');
    if (!parsed.env) console.log('ERROR: --prod or --test is required');
    process.exit(1);
  }

  const config = ENVIRONMENTS[parsed.env];

  switch (parsed.command) {
    case 'inbox':
      await checkInbox(parsed.agent, config, {
        showAll: parsed.all,
        showRead: parsed.read,
        showSent: parsed.sent
      });
      break;

    case 'read':
      if (!parsed.args[0]) {
        console.log('Usage: ... read <message_id>');
        process.exit(1);
      }
      await readMessage(parsed.args[0], parsed.agent, config);
      break;

    case 'send':
      if (parsed.args.length < 2) {
        console.log('Usage: ... send <to_agent> <subject> --body-file <file> OR --body <text>');
        process.exit(1);
      }

      let body = parsed.body || '';
      if (parsed.bodyFile) {
        try {
          body = fs.readFileSync(parsed.bodyFile, 'utf8');
        } catch (e) {
          console.log(`Error reading body file: ${e.message}`);
          process.exit(1);
        }
      }

      if (!body.trim()) {
        console.log('ERROR: Message body required. Use --body-file <file> or --body <text>');
        process.exit(1);
      }

      await sendMessage(parsed.agent, parsed.args[0], parsed.args[1], body, config);
      break;

    case 'agents':
      await listAgents(config);
      break;

    default:
      showHelp();
      console.log(`Unknown command: ${parsed.command}`);
      process.exit(1);
  }
}

main().catch(err => {
  console.log('Error:', err.message);
  process.exit(1);
});
