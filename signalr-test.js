#!/usr/bin/env node
/**
 * SignalR Test Client for Agent Mail Push Notifications
 * 
 * Usage:
 *   node signalr-test.js [dev|prod]
 * 
 * Environment:
 *   VIBE_CLIENT_ID     - Client ID for HMAC auth
 *   VIBE_HMAC_KEY      - HMAC signing key
 *   VIBE_AGENT_NAME    - Your agent name (e.g., "MarcuVale")
 */

const { HubConnectionBuilder, LogLevel } = require('@microsoft/signalr');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration
const ENV = process.argv[2] || 'dev';
const IS_PROD = ENV === 'prod';

const CONFIG = {
  dev: {
    apiUrl: 'http://10.0.0.93:32786',
    idpUrl: 'http://10.0.0.93:32785',
    wsUrl: 'ws://10.0.0.93:32786/hubs/agentmail',
  },
  prod: {
    apiUrl: 'https://api.idealvibe.online',
    idpUrl: 'https://idp.payez.net', // Not used for prod - use device code flow
    wsUrl: 'wss://api.idealvibe.online/hubs/agentmail',
  }
};

const cfg = CONFIG[IS_PROD ? 'prod' : 'dev'];
const CLIENT_ID = process.env.VIBE_CLIENT_ID || (IS_PROD 
  ? 'vibe_b2d2aac0315549d9' 
  : 'vibe_2577f53820d8436d');
const HMAC_KEY = process.env.VIBE_HMAC_KEY || (IS_PROD
  ? 'KAG7vjumrWhx4CHtPSNcowYzjkbeVZmSitD8xjdZXkw='
  : 'fTgHIwYUWBAjh03SDhS6VK25ddHJ1v2ZIFyikG4LI0w=');
const AGENT_NAME = process.env.VIBE_AGENT_NAME || 'MarcuVale';

// Storage for tokens
let accessToken = null;
let refreshToken = null;

/**
 * Generate HMAC signature for API calls
 */
function generateSignature(method, path) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}|${method.toUpperCase()}|${path}`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(HMAC_KEY, 'base64'))
    .update(stringToSign)
    .digest('base64');
  
  return { timestamp, signature };
}

/**
 * Make authenticated API request
 */
function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const { timestamp, signature } = generateSignature(method, path);
    const url = new URL(path, cfg.apiUrl);
    
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: {
        'X-Vibe-Client-Id': CLIENT_ID,
        'X-Vibe-Timestamp': timestamp,
        'X-Vibe-Signature': signature,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    if (accessToken) {
      options.headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const req = (url.protocol === 'https:' ? https : require('http')).request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Device Code Flow: Start authentication
 */
async function startDeviceAuth() {
  console.log('🔐 Starting device code flow...');
  
  // Generate device code via IDP
  const deviceId = IS_PROD ? 'vibe_agents_no_acp' : 'vibe_agents_no_acp';
  
  const response = await apiRequest('POST', '/api/v1/auth/device/code', {
    clientId: CLIENT_ID,
    deviceId: deviceId,
    scopes: ['agent:mail', 'agent:read']
  });

  if (response.status !== 200 || !response.data.success) {
    throw new Error(`Failed to start device flow: ${JSON.stringify(response.data)}`);
  }

  const { deviceCode, userCode, verificationUri, expiresIn, interval } = response.data.data;
  
  console.log('\n📱 Device Code Flow Started');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`User Code:      ${userCode}`);
  console.log(`Verification:   ${verificationUri}`);
  console.log(`Expires in:     ${expiresIn} seconds`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('\n👉 Open the URL above and enter the user code to authorize.');
  console.log('⏳ Waiting for authorization...\n');

  return { deviceCode, interval: interval || 5 };
}

/**
 * Poll for device authorization completion
 */
async function pollDeviceAuth(deviceCode, interval) {
  const maxAttempts = 60; // 5 minutes at 5-second intervals
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, interval * 1000));
    
    process.stdout.write(`⏳ Polling... (attempt ${attempt + 1}/${maxAttempts})\r`);
    
    try {
      // Poll IDP directly for token
      const url = new URL('/api/Auth/device/token', cfg.idpUrl);
      const response = await new Promise((resolve, reject) => {
        const req = require('http').request({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve(data); }
          });
        });
        req.on('error', reject);
        req.write(JSON.stringify({ deviceCode }));
        req.end();
      });

      // Handle nested response structure
      const data = response.data || response;
      
      if (data.access_token) {
        console.log('\n✅ Authorized!                    ');
        accessToken = data.access_token;
        refreshToken = data.refresh_token;
        return {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresIn: data.expires_in
        };
      }
      
      if (data.status === 'authorization_pending') {
        continue; // Keep polling
      }
      
      if (data.status === 'expired_token') {
        throw new Error('Device code expired. Please try again.');
      }
      
      if (data.error) {
        throw new Error(`Auth error: ${data.error}`);
      }
      
    } catch (err) {
      if (err.message.includes('expired') || err.message.includes('Auth error')) {
        throw err;
      }
      // Network errors - keep trying
    }
  }
  
  throw new Error('Authorization timed out after 5 minutes');
}

/**
 * Connect to SignalR hub
 */
async function connectSignalR() {
  console.log('\n📡 Connecting to SignalR hub...');
  console.log(`URL: ${cfg.wsUrl}`);
  
  const connection = new HubConnectionBuilder()
    .withUrl(cfg.wsUrl, {
      accessTokenFactory: () => accessToken,
      transport: require('@microsoft/signalr').HttpTransportType.WebSockets
    })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .configureLogging(LogLevel.Information)
    .build();

  // Event handlers
  connection.on('ReceiveNotification', (notification) => {
    console.log('\n📬 NEW MAIL RECEIVED!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`From:    ${notification.senderAgentName || 'Unknown'}`);
    console.log(`To:      ${notification.recipientAgentName || 'Unknown'}`);
    console.log(`Subject: ${notification.subject || '(no subject)'}`);
    console.log(`Type:    ${notification.mailType || 'standard'}`);
    console.log(`Time:    ${new Date().toISOString()}`);
    console.log('═══════════════════════════════════════════════════════════');
    if (notification.content) {
      console.log(`Content: ${notification.content.substring(0, 200)}...`);
    }
  });

  connection.on('MailRead', (data) => {
    console.log(`📖 Mail marked as read: ${data.mailId}`);
  });

  connection.on('ConnectionAck', (data) => {
    console.log(`✅ Connected! Connection ID: ${data.connectionId}`);
    console.log(`   Subscribed agents: ${data.subscribedAgents?.join(', ') || 'none'}`);
  });

  connection.onreconnecting((error) => {
    console.log('🔄 Reconnecting...', error?.message || '');
  });

  connection.onreconnected((connectionId) => {
    console.log('✅ Reconnected! ID:', connectionId);
  });

  connection.onclose((error) => {
    console.log('❌ Connection closed', error ? `: ${error.message}` : '');
    process.exit(0);
  });

  await connection.start();
  
  // Subscribe to our agent
  console.log(`\n📝 Subscribing to agent: ${AGENT_NAME}`);
  await connection.invoke('SubscribeToAgent', AGENT_NAME);
  
  return connection;
}

/**
 * Send a test message to ourselves
 */
async function sendTestMessage() {
  console.log('\n📤 Sending test message...');
  
  const response = await apiRequest('POST', '/api/v1/agent/mail', {
    recipientAgentName: AGENT_NAME,
    subject: 'SignalR Test Message',
    content: `This is a test message sent at ${new Date().toISOString()}`,
    mailType: 'standard',
    priority: 'normal',
    metadata: {
      source: 'signalr-test-script',
      testRun: true
    }
  });

  if (response.status === 200 || response.status === 201) {
    console.log('✅ Test message sent successfully!');
    console.log('   Response:', JSON.stringify(response.data, null, 2));
  } else {
    console.log('❌ Failed to send message:', response.status);
    console.log('   Response:', response.data);
  }
}

/**
 * Main function
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     SignalR Agent Mail Test Client                         ║');
  console.log('║     Environment:', ENV.padEnd(47), '║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log();

  try {
    // Step 1: Authenticate via device code flow
    const { deviceCode, interval } = await startDeviceAuth();
    const tokens = await pollDeviceAuth(deviceCode, interval);
    
    console.log(`\n🔑 Token acquired (expires in ${tokens.expiresIn}s)`);
    console.log(`   Access Token:  ${tokens.accessToken.substring(0, 50)}...`);
    
    // Step 2: Connect to SignalR
    const connection = await connectSignalR();
    
    // Step 3: Send test message
    await sendTestMessage();
    
    // Step 4: Keep listening
    console.log('\n👂 Listening for notifications...');
    console.log('   Press Ctrl+C to exit\n');
    
    // Keep alive
    setInterval(() => {
      // Heartbeat to keep connection alive
    }, 30000);
    
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Goodbye!');
  process.exit(0);
});

main();
