#!/usr/bin/env node
/**
 * Simple WebSocket Test for SignalR Hub
 * Raw WebSocket connection without SignalR client library
 * 
 * Usage: node ws-test.js [dev|prod]
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const ENV = process.argv[2] || 'dev';
const IS_PROD = ENV === 'prod';

const CONFIG = {
  dev: {
    apiUrl: 'http://10.0.0.93:32786',
    idpUrl: 'http://10.0.0.93:32785',
    wsUrl: 'ws://10.0.0.93:32786/hubs/agentmail',
    clientId: 'vibe_2577f53820d8436d',
    hmacKey: 'fTgHIwYUWBAjh03SDhS6VK25ddHJ1v2ZIFyikG4LI0w='
  },
  prod: {
    apiUrl: 'https://api.idealvibe.online',
    idpUrl: 'https://idp.payez.net',
    wsUrl: 'wss://api.idealvibe.online/hubs/agentmail',
    clientId: 'vibe_b2d2aac0315549d9',
    hmacKey: 'KAG7vjumrWhx4CHtPSNcowYzjkbeVZmSitD8xjdZXkw='
  }
};

const cfg = CONFIG[IS_PROD ? 'prod' : 'dev'];
const AGENT_NAME = process.env.VIBE_AGENT_NAME || 'MarcuVale';

let accessToken = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * Generate HMAC signature
 */
function generateSignature(method, path) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}|${method.toUpperCase()}|${path}`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(cfg.hmacKey, 'base64'))
    .update(stringToSign)
    .digest('base64');
  return { timestamp, signature };
}

/**
 * Make HTTP request
 */
function httpRequest(method, path, body = null, useIdp = false) {
  return new Promise((resolve, reject) => {
    const isHttps = useIdp ? false : IS_PROD;
    const baseUrl = useIdp ? cfg.idpUrl : cfg.apiUrl;
    const url = new URL(path, baseUrl);
    
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    if (!useIdp) {
      const { timestamp, signature } = generateSignature(method, path);
      options.headers['X-Vibe-Client-Id'] = cfg.clientId;
      options.headers['X-Vibe-Timestamp'] = timestamp;
      options.headers['X-Vibe-Signature'] = signature;
      if (accessToken) {
        options.headers['Authorization'] = `Bearer ${accessToken}`;
      }
    }

    const client = isHttps ? https : http;
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Get device code
 */
async function getDeviceCode() {
  log('🔐 Requesting device code...');
  
  const res = await httpRequest('POST', '/api/v1/auth/device/code', {
    clientId: cfg.clientId,
    deviceId: 'vibe_agents_no_acp',
    scopes: ['agent:mail', 'agent:read']
  });

  if (res.status !== 200 || !res.data.success) {
    throw new Error(`Device code failed: ${JSON.stringify(res.data)}`);
  }

  return res.data.data;
}

/**
 * Poll for token
 */
async function pollForToken(deviceCode, interval) {
  const maxAttempts = 60;
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, interval * 1000));
    process.stdout.write(`⏳ Polling ${i + 1}/${maxAttempts}...\r`);
    
    try {
      // Poll IDP directly
      const res = await httpRequest('POST', '/api/Auth/device/token', 
        { deviceCode }, true);
      
      const data = res.data.data || res.data;
      
      if (data.access_token) {
        console.log('\n✅ Got token!');
        accessToken = data.access_token;
        return data;
      }
      
      if (data.status === 'authorization_pending') continue;
      if (data.status === 'expired_token') throw new Error('Code expired');
      if (data.error) throw new Error(data.error);
      
    } catch (err) {
      if (err.message.includes('expired') || err.message.includes('error')) {
        throw err;
      }
    }
  }
  
  throw new Error('Timeout');
}

/**
 * Connect WebSocket with SignalR protocol
 */
async function connectWebSocket() {
  return new Promise((resolve, reject) => {
    log('🔌 Connecting WebSocket...');
    
    const wsUrl = `${cfg.wsUrl}?access_token=${accessToken}`;
    const ws = new WebSocket(wsUrl, [], {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    ws.on('open', () => {
      log('✅ WebSocket connected!');
      
      // Send SignalR handshake
      const handshake = JSON.stringify({ protocol: 'json', version: 1 }) + '\x1e';
      ws.send(handshake);
      log('📤 Sent handshake');
    });

    ws.on('message', (data) => {
      const messages = data.toString().split('\x1e').filter(m => m.trim());
      
      for (const msg of messages) {
        try {
          const parsed = JSON.parse(msg);
          handleMessage(ws, parsed);
        } catch (e) {
          log('⚠️  Parse error:', msg.substring(0, 100));
        }
      }
    });

    ws.on('error', (err) => {
      log('❌ WebSocket error:', err.message);
      reject(err);
    });

    ws.on('close', (code, reason) => {
      log('🔒 WebSocket closed:', code, reason?.toString() || '');
      process.exit(0);
    });

    resolve(ws);
  });
}

/**
 * Handle incoming SignalR messages
 */
function handleMessage(ws, msg) {
  // Handshake response
  if (msg.type === 1) {
    log('✅ Handshake complete');
    
    // Subscribe to agent
    const subscribeMsg = {
      type: 1, // Invocation
      target: 'SubscribeToAgent',
      arguments: [AGENT_NAME],
      invocationId: '1'
    };
    ws.send(JSON.stringify(subscribeMsg) + '\x1e');
    log('📤 Subscribed to agent:', AGENT_NAME);
    return;
  }
  
  // Invocation result
  if (msg.type === 3) {
    log('✅ Invocation result:', msg.invocationId, msg.result || msg.error);
    return;
  }
  
  // Server invocation (notification)
  if (msg.type === 1 && msg.target) {
    log('📬 Server invoked:', msg.target);
    log('   Arguments:', JSON.stringify(msg.arguments, null, 2));
    return;
  }
  
  // Ping
  if (msg.type === 6) {
    // Pong
    ws.send(JSON.stringify({ type: 6 }) + '\x1e');
    return;
  }
  
  log('📨 Message:', JSON.stringify(msg, null, 2));
}

/**
 * Send test mail via REST API
 */
async function sendTestMail() {
  log('📤 Sending test mail...');
  
  const res = await httpRequest('POST', '/api/v1/agent/mail', {
    recipientAgentName: AGENT_NAME,
    subject: 'WebSocket Test',
    content: `Test at ${new Date().toISOString()}`,
    mailType: 'standard',
    priority: 'normal'
  });
  
  if (res.status === 200 || res.status === 201) {
    log('✅ Mail sent:', res.data.mailId || 'OK');
  } else {
    log('❌ Send failed:', res.status, res.data);
  }
}

/**
 * Main
 */
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  SignalR WebSocket Test');
  console.log(`  Environment: ${ENV}`);
  console.log(`  Agent: ${AGENT_NAME}`);
  console.log('═══════════════════════════════════════════\n');

  try {
    // Auth
    const { deviceCode, userCode, verificationUri, interval } = await getDeviceCode();
    console.log(`User Code: ${userCode}`);
    console.log(`URL: ${verificationUri}\n`);
    console.log('👉 Authorize, then waiting...\n');
    
    await pollForToken(deviceCode, interval);
    
    // Connect WebSocket
    const ws = await connectWebSocket();
    
    // Wait a moment for subscription
    await new Promise(r => setTimeout(r, 2000));
    
    // Send test
    await sendTestMail();
    
    // Keep alive
    console.log('\n👂 Listening... (Ctrl+C to exit)\n');
    
    setInterval(() => {
      ws.send(JSON.stringify({ type: 6 }) + '\x1e');
    }, 30000);
    
  } catch (err) {
    log('💥 Fatal error:', err.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('\n👋 Bye!');
  process.exit(0);
});

main();
