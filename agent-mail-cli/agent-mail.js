#!/usr/bin/env node
/**
 * Shared Agent Mail CLI v2 - Developer Experience Improved
 * Location: E:\Repos\acp-desktop\agent-mail-cli\agent-mail.js
 *
 * IMPORTANT: This CLI hits CLOUD mail by default (api.idealvibe.online).
 *            Use --local flag to hit LOCAL VibeSQL storage (localhost:3001).
 *            Projects/persistence live in CLOUD. Local is ephemeral.
 *
 * Usage: node agent-mail.js [options] <command> [args]
 *
 * QUICK START:
 *   node agent-mail.js init                       # Create config interactively
 *   node agent-mail.js inbox                      # Check CLOUD inbox (default)
 *   node agent-mail.js inbox --local              # Check LOCAL inbox
 *   node agent-mail.js clear                      # Mark CLOUD mail as read
 *   node agent-mail.js clear --local              # Mark LOCAL mail as read
 *   node agent-mail.js read-last                  # Read most recent message
 *
 * Commands:
 *   init                     - Create ~/.acp-mail.json config file
 *   inbox                    - Check unread messages (CLOUD by default)
 *   inbox --all              - Show all messages
 *   inbox --read             - Show read messages
 *   inbox --sent             - Show sent messages
 *   read <message_id>        - Read specific message by message_id
 *   read-last                - Read the most recent message (marks as read)
 *   send <to> <subject>      - Send message (CLOUD only, use --body-file or --body)
 *   clear                    - Mark ALL messages as read
 *   mark-read <inbox_id>     - Mark specific inbox entry as read (uses inbox_id)
 *   status                   - Show both CLOUD and LOCAL unread counts
 *   agents                   - List all registered agents
 *   config                   - Show current configuration
 *
 * Options (override config file):
 *   --agent <name>           - Your agent name
 *   --prod, --test           - Environment selection (for cloud)
 *   --local                  - Use LOCAL VibeSQL instead of CLOUD
 *   --body-file <path>       - Read message body from file
 *   --body <text>            - Message body as argument
 *
 * Config File (~/.acp-mail.json):
 *   {
 *     "agent": "BAPert",
 *     "environment": "prod",
 *     "showUnreadOnInbox": true
 *   }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CONFIG_PATH = path.join(os.homedir(), '.acp-mail.json');

// IDP client-app identity (matches idp_client_apps.name for acp-desktop owned by idealvibe_online)
const IDP_CLIENT_APP = 'acp_desktop';

// Cloud creds come from env or ~/.acp-mail.json (vibeClientId, vibeClientSecret).
// Hardcoded credentials were removed — set env vars or populate the config file.
function loadCloudCreds(env) {
  const cfg = loadConfig();
  if (env === 'prod') {
    return {
      apiUrl: process.env.ACP_VIBE_API_URL || cfg.vibeApiUrl || 'https://api.idealvibe.online/v1/agentmail',
      clientId: process.env.ACP_VIBE_CLIENT_ID || cfg.vibeClientId || '',
      secretKey: process.env.ACP_VIBE_CLIENT_SECRET || cfg.vibeClientSecret || ''
    };
  }
  return {
    apiUrl: process.env.ACP_VIBE_API_URL_TEST || cfg.vibeApiUrlTest || 'http://localhost/v1/agentmail',
    clientId: process.env.ACP_VIBE_CLIENT_ID_TEST || cfg.vibeClientIdTest || '',
    secretKey: process.env.ACP_VIBE_CLIENT_SECRET_TEST || cfg.vibeClientSecretTest || ''
  };
}

// DEFAULT: Local acp-api (recommended - full features, central auth)
// Fallback: Cloud API (limited features, per-call auth)

const API_CONFIG = {
  // PRIMARY: Local acp-api - handles auth centrally, full pagination, bulk ops
  local: {
    apiUrl: 'http://127.0.0.1:3001/v1/messages',
    authType: 'bearer',  // Uses ACP_LOCAL_SECRET from acp-api
    features: ['pagination', 'bulk-read', 'simple-auth']
  }
};

// ============================================================================
// Config Management
// ============================================================================

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      let content = fs.readFileSync(CONFIG_PATH, 'utf8');
      // Strip BOM if present (UTF-16/Windows PowerShell issue)
      if (content.charCodeAt(0) === 0xFEFF) {
        content = content.substring(1);
      }
      return JSON.parse(content);
    }
  } catch (err) {
    console.error(`Warning: Could not load config: ${err.message}`);
    // Try to repair corrupted config
    try {
      fs.unlinkSync(CONFIG_PATH);
      console.log('Removed corrupted config. Run "init" to recreate.');
    } catch {}
  }
  return {};
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`✓ Config saved to ${CONFIG_PATH}`);
  } catch (err) {
    console.error(`Error saving config: ${err.message}`);
    process.exit(1);
  }
}

function showConfig() {
  const config = loadConfig();
  console.log('\nCurrent Configuration:\n');
  console.log(`  Config file: ${CONFIG_PATH}`);
  console.log(`  Agent: ${config.agent || '(not set)'}`);
  console.log(`  Environment: ${config.environment || '(not set)'}`);
  console.log(`  Show unread on inbox: ${config.showUnreadOnInbox !== false ? 'yes' : 'no'}`);
  console.log('');
}

async function initConfig() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  console.log('\n=== Agent Mail CLI Configuration ===\n');
  
  const agent = await question('Your agent name (e.g., BAPert): ');
  const env = await question('Default environment (prod/test) [prod]: ');
  
  rl.close();

  const config = {
    agent: agent.trim() || undefined,
    environment: env.trim() === 'test' ? 'test' : 'prod',
    showUnreadOnInbox: true
  };

  saveConfig(config);
  console.log('\n✓ Configuration complete! Try: node agent-mail.js inbox');
}

// ============================================================================
// Argument Parsing
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = loadConfig();
  
  const parsed = {
    agent: config.agent || null,
    env: 'prod',  // DEFAULT: cloud API (production)
    local: false, // DEFAULT: cloud API, not local
    command: null,
    args: [],
    bodyFile: null,
    body: null,
    all: false,
    read: false,
    sent: false,
    help: false
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--agent' && args[i + 1]) {
      parsed.agent = args[++i];
    } else if (arg === '--dev') {
      parsed.local = true;   // DEV ONLY: Use local VibeSQL
      parsed.env = null;     // Disable cloud
    } else if (arg === '--test') {
      parsed.env = 'test';   // Test cloud environment
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
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
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

// ============================================================================
// API Functions - CLOUD (api.idealvibe.online)
// ============================================================================

function sign(method, urlPath, config) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto.createHmac('sha256', Buffer.from(config.secretKey, 'base64'))
    .update(`${timestamp}|${method}|${urlPath}`)
    .digest('base64');
  return { timestamp, signature };
}

async function apiCall(method, urlPath, config, body = null) {
  if (!config.clientId || !config.secretKey) {
    throw new Error(
      'Cloud API requires vibe credentials. Set ACP_VIBE_CLIENT_ID + ACP_VIBE_CLIENT_SECRET ' +
      'or vibeClientId + vibeClientSecret in ~/.acp-mail.json. Hardcoded creds have been removed.'
    );
  }
  const { timestamp, signature } = sign(method, urlPath, config);

  const options = {
    method,
    headers: {
      'X-Vibe-Client-Id': config.clientId,
      'X-Vibe-Timestamp': timestamp,
      'X-Vibe-Signature': signature,
      'X-IDP-Client-App': IDP_CLIENT_APP,
    }
  };

  // Add required headers for POST/PUT requests (even without body)
  if (method === 'POST' || method === 'PUT') {
    options.headers['Content-Type'] = 'application/json';
    options.headers['X-Vibe-User-Id'] = '1';
    // API requires empty body for POST requests without payload
    options.body = body ? JSON.stringify(body) : '{}';
  }

  const endpoint = urlPath.replace('/v1/agentmail', '');
  const response = await fetch(`${config.apiUrl}${endpoint}`, options);
  return response.json();
}

// ============================================================================
// API Functions - LOCAL (localhost:3001 VibeSQL)
// ============================================================================

async function localApiCall(method, urlPath, agentName, body = null) {
  const url = `http://127.0.0.1:3001${urlPath}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-ACP-Agent': agentName,
      'X-IDP-Client-App': IDP_CLIENT_APP,
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  return response.json();
}

async function checkLocalInbox(agentName, { showAll, showRead } = {}) {
  const result = await localApiCall('GET', `/v1/messages/inbox/${agentName}`, agentName);
  if (result.success && result.data) {
    let messages, label;
    const totalCount = result.data.length;
    if (showAll) {
      messages = result.data;
      label = `${totalCount} messages`;
    } else if (showRead) {
      messages = result.data.filter(m => m.isRead || m.readAt);
      label = `${messages.length} read of ${totalCount} total`;
    } else {
      messages = result.data.filter(m => !m.isRead && !m.readAt);
      label = `${messages.length} unread of ${totalCount} total`;
    }
    console.log(`\n[LOCAL] Inbox for ${agentName} (${label})\n`);
    if (messages.length === 0) {
      const hint = showAll ? '' : showRead ? '' : ' Use --all to see all.';
      console.log('  No messages.' + hint);
    } else {
      messages.forEach(m => {
        const message_id = m.message_id || '?';
        const unread = (!m.isRead && !m.readAt) ? ' [UNREAD]' : '';
        console.log(`  [${message_id}] From: ${m.fromAgent || m.from_agent}${unread}`);
        console.log(`     Subject: ${m.subject}`);
        console.log(`     Date: ${new Date(m.createdAt || m.created_at).toLocaleString()}\n`);
      });
    }
  } else {
    console.log('Error:', result.error || result);
  }
}

async function readLocalMessage(message_id, agentName) {
  const result = await localApiCall('GET', `/v1/messages/${message_id}`, agentName);
  // Note: GET /v1/messages/:id auto-marks as read
  if (result.success && result.data) {
    const m = result.data;
    console.log('\n[LOCAL] ' + '='.repeat(56));
    console.log(`From: ${m.fromAgent || m.from_agent}`);
    console.log(`To: ${agentName}`);
    console.log(`Subject: ${m.subject}`);
    console.log(`Date: ${new Date(m.createdAt || m.created_at).toLocaleString()}`);
    if (m.clusterId || m.cluster_id) console.log(`Cluster: ${m.clusterId || m.cluster_id}`);
    console.log('='.repeat(60) + '\n');
    console.log(m.body);
    console.log('\n' + '='.repeat(60) + '\n');
  } else {
    console.log('Error:', result.error || result);
  }
}

async function clearLocalMessages(agentName) {
  console.log(`\n[LOCAL] Marking all messages as read for ${agentName}...`);
  const result = await localApiCall('PUT', `/v1/messages/inbox/${agentName}/read`, agentName);
  
  if (result.success) {
    console.log(`✓ Local messages marked as read for ${agentName}`);
  } else {
    console.log('Error:', result.error || result);
  }
}

async function showStatus(agentName, config) {
  console.log('\n=== Mail Status ===\n');
  
  // Check CLOUD
  try {
    const cloudResult = await apiCall('GET', `/v1/agentmail/inbox/${agentName}`, config);
    if (cloudResult.success && cloudResult.data?.messages) {
      const unread = cloudResult.data.unread_count ?? cloudResult.data.messages.filter(m => !m.read_at).length;
      const total = cloudResult.pagination?.total_count ?? cloudResult.data.messages.length;
      console.log(`[CLOUD] api.idealvibe.online: ${unread} unread / ${total} total`);
    } else {
      console.log('[CLOUD] api.idealvibe.online: Error fetching');
    }
  } catch (e) {
    console.log('[CLOUD] api.idealvibe.online: Unavailable');
  }
  
  // Check LOCAL
  try {
    const localResult = await localApiCall('GET', `/v1/messages/inbox/${agentName}`, agentName);
    if (localResult.success && localResult.data) {
      const unread = localResult.data.filter(m => !m.isRead && !m.readAt).length;
      const total = localResult.data.length;
      console.log(`[LOCAL] localhost:3001:        ${unread} unread / ${total} total`);
    } else {
      console.log('[LOCAL] localhost:3001:        Error fetching');
    }
  } catch (e) {
    console.log('[LOCAL] localhost:3001:        Unavailable');
  }
  
  console.log('\nNote: Projects/persistence live in CLOUD. Local is ephemeral.');
  console.log('      Use --local flag for local VibeSQL storage.\n');
}

// Missing local functions
async function readLocalLastMessage(agentName) {
  const result = await localApiCall('GET', `/v1/messages/inbox/${agentName}`, agentName);
  if (result.success && result.data && result.data.length > 0) {
    const lastMessage = result.data[0];
    console.log(`\nReading most recent message (message_id: ${lastMessage.message_id})...`);
    await readLocalMessage(lastMessage.message_id, agentName);
  } else {
    console.log('No messages in inbox.');
  }
}

async function sendLocalMessage(fromAgent, toAgent, subject, body) {
  // Local API may not support send - proxy to cloud or warn
  console.log('[LOCAL] Send not supported via local API.');
  console.log('        Use --prod flag to send via cloud API:');
  console.log(`        node agent-mail.js send ${toAgent} "${subject}" --body "..." --prod`);
  throw new Error('Send requires --prod flag');
}

async function markLocalMessageRead(message_id, agentName) {
  // GET /v1/messages/:message_id auto-marks as read
  await readLocalMessage(message_id, agentName);
  console.log(`✓ Message ${message_id} marked as read`);
}

async function listLocalAgents() {
  // Local API doesn't have agents endpoint, show message
  console.log('\n[LOCAL] Agents list not available in local mode.');
  console.log('        Use --prod to see cloud agents list.\n');
}

async function showLocalStatus(agentName) {
  console.log('\n=== Mail Status (Local API) ===\n');
  try {
    const result = await localApiCall('GET', `/v1/messages/inbox/${agentName}`, agentName);
    if (result.success && result.data) {
      const unread = result.data.filter(m => !m.isRead && !m.readAt).length;
      const total = result.data.length;
      console.log(`[LOCAL] localhost:3001: ${unread} unread / ${total} total`);
      
      if (unread > 20) {
        console.log(`\n⚠️  You have ${unread} unread messages!`);
        console.log(`   Run 'node agent-mail.js clear' to mark all as read.\n`);
      }
    } else {
      console.log('[LOCAL] Error fetching status');
    }
  } catch (e) {
    console.log('[LOCAL] Unavailable - is acp-api running?');
  }
  console.log('');
}

async function showCloudStatus(agentName, config) {
  console.log('\n=== Mail Status (Cloud API) ===\n');
  try {
    const result = await apiCall('GET', `/v1/agentmail/inbox/${agentName}`, config);
    if (result.success && result.data?.messages) {
      const unread = result.data.messages.filter(m => !m.read_at).length;
      const total = result.pagination?.total_count ?? result.data.messages.length;
      console.log(`[CLOUD] api.idealvibe.online: ${unread} unread / ${total} total`);
      
      if (unread > 20) {
        console.log(`\n⚠️  You have ${unread} unread messages!`);
        console.log(`   Note: Cloud API has 20 message limit.`);
        console.log(`   Use local API (no --prod flag) for full access.\n`);
      }
    } else {
      console.log('[CLOUD] Error fetching status');
    }
  } catch (e) {
    console.log('[CLOUD] Unavailable');
  }
  console.log('');
}

// Renamed cloud functions for clarity
async function checkCloudInbox(agentName, config, { showAll, showRead, showSent } = {}) {
  // Original checkInbox implementation
  await checkInbox(agentName, config, { showAll, showRead, showSent });
}

async function readCloudMessage(id, agentName, config) {
  await readMessage(id, agentName, config);
}

async function readCloudLastMessage(agentName, config) {
  await readLastMessage(agentName, config);
}

async function sendCloudMessage(fromAgent, toAgent, subject, body, config) {
  await sendMessage(fromAgent, toAgent, subject, body, config);
}

async function clearCloudMessages(agentName, config) {
  await clearAllMessages(agentName, config);
}

async function markCloudMessageRead(inbox_id, config) {
  await markInboxRead(inbox_id, config);
}

async function listCloudAgents(config) {
  await listAgents(config);
}

// Fetch all messages across all pages (local API supports pagination, cloud does not)
async function fetchAllMessages(agentName, config) {
  const allMessages = [];
  let page = 1;
  let hasMore = true;
  
  while (hasMore && page <= 50) { // safety cap
    const result = await apiCall('GET', 
      `/v1/agentmail/inbox/${agentName}?page=${page}&page_size=50`, config);
    const messages = result.data?.messages || [];
    allMessages.push(...messages);
    hasMore = messages.length === 50;
    page++;
  }
  
  // If no pagination support (cloud API), return what we got
  if (allMessages.length === 0) {
    const result = await apiCall('GET', `/v1/agentmail/inbox/${agentName}`, config);
    return result.data?.messages || [];
  }
  
  return allMessages;
}

// Check for backlog warning
function checkBacklogWarning(messages, unreadCount, totalCount) {
  const unread = unreadCount ?? messages?.filter(m => !m.read_at).length ?? 0;
  const total = totalCount ?? messages?.length ?? 0;
  const showing = messages?.length ?? 0;
  
  if (unread > 20) {
    console.log(`\n⚠️  WARNING: You have ${unread} unread messages!`);
    if (showing < total) {
      console.log(`   (Showing ${showing} of ${total} total - API limit)`);
    }
    console.log(`   Run 'node agent-mail.js inbox --all' to see all.`);
    console.log(`   Run 'node agent-mail.js clear' to mark all as read.\n`);
  }
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
          const message_id = m.message_id || '?';
          const to = m.to_agent_display || m.to_agent || m.to || '?';
          console.log(`  [${message_id}] To: ${to}`);
          console.log(`     Subject: ${m.subject}`);
          console.log(`     Date: ${new Date(m.created_at).toLocaleString()}\n`);
        });
      }
    } else {
      console.log('Error:', result.error || result);
    }
    return;
  }

  // Fetch all pages (or single page for cloud API)
  const allMessages = await fetchAllMessages(agentName, config);
  
  // Get pagination info from original response for warning
  const rawResult = await apiCall('GET', `/v1/agentmail/inbox/${agentName}`, config);
  const pagination = rawResult.pagination;
  const totalFromApi = pagination?.total_count || allMessages.length;
  const unreadFromApi = rawResult.data?.unread_count;
  
  if (allMessages.length > 0) {
    checkBacklogWarning(allMessages, unreadFromApi, totalFromApi);
  }
  
  let messages, label;
  const totalCount = totalFromApi || allMessages.length;
  if (showAll) {
    messages = allMessages;
    label = `${totalCount} messages`;
  } else if (showRead) {
    messages = allMessages.filter(m => m.read_at);
    label = `${messages.length} read of ${totalCount} total`;
  } else {
    messages = allMessages.filter(m => !m.read_at);
    label = `${messages.length} unread of ${totalCount} total`;
  }
  console.log(`\nInbox for ${agentName} (${label})\n`);
  if (messages.length === 0) {
    const hint = showAll ? '' : showRead ? '' : ' Use --all to see all.';
    console.log('  No messages.' + hint);
  } else {
    messages.forEach(m => {
      const message_id = m.message_id || '?';
      const unread = !m.read_at ? ' [UNREAD]' : '';
      console.log(`  [${message_id}] From: ${m.from_agent_display || m.from_agent}${unread}`);
      console.log(`     Subject: ${m.subject}`);
      console.log(`     Date: ${new Date(m.created_at).toLocaleString()}\n`);
    });
  }
}

async function readMessage(id, agentName, config, markAsRead = false) {
  const result = await apiCall('GET', `/v1/agentmail/messages/${id}`, config);
  if (result.success && result.data) {
    const m = result.data;
    const fromAgent = m.from_agent_display || m.from_agent;
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
    
    // Mark as read if requested and not already read
    if (markAsRead && !m.read_at) {
      await markInboxRead(inbox_id, config);
    }
  } else {
    console.log('Error:', result.error || result);
  }
}

async function readLastMessage(agentName, config) {
  const allMessages = await fetchAllMessages(agentName, config);
  if (allMessages.length === 0) {
    console.log('No messages in inbox.');
    return;
  }
  
  // Get most recent message (already sorted by date desc from API)
  const lastMessage = allMessages[0];
  console.log(`\nReading most recent message (message_id: ${lastMessage.message_id})...`);
  await readMessage(lastMessage.message_id, agentName, config, true);
}

async function sendMessage(agentName, to, subject, body, config) {
  const result = await apiCall('POST', '/v1/agentmail/send', config, {
    from_agent: agentName,
    to: [to],
    subject,
    body
  });
  if (result.success) {
    console.log(`✓ Message sent to ${to} (ID: ${result.data?.message_id || 'OK'})`);
  } else {
    console.log('Send failed:', result.error || result);
  }
}

async function markInboxRead(inbox_id, config) {
  const result = await apiCall('POST', `/v1/agentmail/inbox/${inbox_id}/read`, config);
  if (result.success) {
    console.log(`✓ inbox_id ${inbox_id} marked as read`);
  } else {
    console.log('Error marking as read:', result.error || result);
  }
  return result.success;
}

async function clearAllMessages(agentName, config) {
  console.log(`\nClearing all messages for ${agentName}...`);
  
  // Try bulk endpoint first (vibe-2.92+)
  const result = await apiCall('POST', `/v1/agentmail/inbox/${agentName}/read-all`, config);
  
  if (result.success) {
    const marked = result.data?.marked || 0;
    const total = result.data?.total || 0;
    if (marked === 0) {
      console.log('✓ No unread messages to clear.');
    } else {
      console.log(`✓ Marked ${marked}/${total} messages as read`);
    }
    return;
  }
  
  // Fallback: individual mark-read for older APIs
  console.log('Bulk endpoint not available, using fallback...');
  const allMessages = await fetchAllMessages(agentName, config);
  const unreadMessages = allMessages.filter(m => !m.read_at);
  
  if (unreadMessages.length === 0) {
    console.log('✓ No unread messages to clear.');
    return;
  }
  
  console.log(`Found ${unreadMessages.length} unread message(s). Marking as read...\n`);
  
  let successCount = 0;
  for (let i = 0; i < unreadMessages.length; i++) {
    const m = unreadMessages[i];
    const inbox_id = m.inbox_id;
    const success = await markInboxRead(inbox_id, config);
    if (success) successCount++;
    
    if ((i + 1) % 10 === 0 || i === unreadMessages.length - 1) {
      console.log(`  Progress: ${i + 1}/${unreadMessages.length}`);
    }
  }
  
  console.log(`\n✓ Cleared ${successCount}/${unreadMessages.length} messages`);
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

// ============================================================================
// Help
// ============================================================================

function showHelp() {
  console.log(`
Agent Mail CLI v3 - Production Edition

IMPORTANT:
  CLOUD (default): api.idealvibe.online  - Production API
  LOCAL (--dev):   localhost:3001        - Dev/testing ONLY

QUICK START:
  node agent-mail.js init                   # Create config file
  node agent-mail.js inbox                  # Check inbox (CLOUD default)
  node agent-mail.js clear                  # Mark as read (CLOUD)
  node agent-mail.js status                 # Show mail counts

COMMANDS:
  init                      Create ~/.acp-mail.json config
  inbox                     Check unread messages (CLOUD by default)
  inbox --all               Show all messages
  inbox --read              Show read messages
  inbox --sent              Show sent messages
  read <message_id>         Read specific message by message_id
  read-last                 Read most recent (auto-marks read)
  send <to> <subject>       Send message
  clear                     Mark messages as read
  mark-read <inbox_id>      Mark specific inbox entry as read (uses inbox_id)
  status                    Show unread counts
  agents                    List all agents
  config                    Show current configuration

OPTIONS (override config):
  --agent <name>            Your agent name
  --dev                     Use LOCAL localhost:3001 (dev ONLY)
  --body-file <path>        Read body from file
  --body <text>             Inline body text

EXAMPLES:
  node agent-mail.js init
  node agent-mail.js inbox              # CLOUD - production
  node agent-mail.js clear              # CLOUD - production
  node agent-mail.js inbox --dev        # LOCAL - dev only
  node agent-mail.js send NextPert "Status" --body "All good"

NOTE: CLOUD is default for production. Use --dev only for local testing.
`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const parsed = parseArgs();

  if (parsed.help || (!parsed.command && process.argv.length <= 2)) {
    showHelp();
    process.exit(0);
  }

  // Config commands don't require agent/env
  if (parsed.command === 'init') {
    await initConfig();
    process.exit(0);
  }
  
  if (parsed.command === 'config') {
    showConfig();
    process.exit(0);
  }

  // Validate required args
  if (!parsed.agent) {
    showHelp();
    console.log('\n' + '='.repeat(60));
    console.log('ERROR: --agent <name> is required (or set in ~/.acp-mail.json)');
    console.log('='.repeat(60) + '\n');
    console.log('Run "node agent-mail.js init" to create a config file.\n');
    process.exit(1);
  }

  // Route commands based on local vs cloud
  // DEFAULT: cloud API (production)
  // LOCAL: only when --dev explicitly set (dev/testing)
  
  if (parsed.command === 'status') {
    if (parsed.local) {
      await showLocalStatus(parsed.agent);
    } else {
      const cloudConfig = loadCloudCreds(parsed.env || 'prod');
      await showCloudStatus(parsed.agent, cloudConfig);
    }
    process.exit(0);
  }

  // Route commands based on local vs cloud
  if (parsed.local) {
    // LOCAL API (default) - better features, central auth
    switch (parsed.command) {
      case 'inbox':
        await checkLocalInbox(parsed.agent, {
          showAll: parsed.all,
          showRead: parsed.read,
        });
        break;

      case 'read':
        if (!parsed.args[0]) {
          console.log('Usage: ... read <message_id>');
          process.exit(1);
        }
        await readLocalMessage(parsed.args[0], parsed.agent);
        break;

      case 'read-last':
        await readLocalLastMessage(parsed.agent);
        break;

      case 'send':
        // Local API proxies to cloud for sending
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
        await sendLocalMessage(parsed.agent, parsed.args[0], parsed.args[1], body);
        break;

      case 'clear':
        await clearLocalMessages(parsed.agent);
        break;

      case 'mark-read':
        if (!parsed.args[0]) {
          console.log('Usage: ... mark-read <inbox_id>');
          process.exit(1);
        }
        await markLocalMessageRead(parsed.args[0], parsed.agent);
        break;

      case 'agents':
        await listLocalAgents();
        break;

      default:
        showHelp();
        console.log(`Unknown command: ${parsed.command}`);
        process.exit(1);
    }
  } else {
    // CLOUD API (fallback) - use --prod or --test
    const cloudConfig = loadCloudCreds(parsed.env || 'prod');
    switch (parsed.command) {
      case 'inbox':
        await checkCloudInbox(parsed.agent, cloudConfig, {
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
        await readCloudMessage(parsed.args[0], parsed.agent, cloudConfig);
        break;

      case 'read-last':
        await readCloudLastMessage(parsed.agent, cloudConfig);
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
        await sendCloudMessage(parsed.agent, parsed.args[0], parsed.args[1], body, cloudConfig);
        break;

      case 'clear':
        await clearCloudMessages(parsed.agent, cloudConfig);
        break;

      case 'mark-read':
        if (!parsed.args[0]) {
          console.log('Usage: ... mark-read <inbox_id>');
          process.exit(1);
        }
        await markCloudMessageRead(parsed.args[0], cloudConfig);
        break;

      case 'agents':
        await listCloudAgents(cloudConfig);
        break;

      default:
        showHelp();
        console.log(`Unknown command: ${parsed.command}`);
        process.exit(1);
    }
  }
}

main().catch(err => {
  console.log('Error:', err.message);
  process.exit(1);
});
