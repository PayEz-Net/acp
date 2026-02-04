#!/usr/bin/env node
/**
 * SignalR Test using Internal Agent Auth
 * Gets bearer token via HMAC auth, then connects to SignalR
 * 
 * Usage: node agent-auth-test.js [dev|prod] [userId]
 */

const { HubConnectionBuilder, LogLevel } = require('@microsoft/signalr');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const ENV = process.argv[2] || 'dev';
const USER_ID = parseInt(process.argv[3] || '22', 10); // Default to user 22 (jonranes)
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
let tokenExpiresAt = null;

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
  return { timestamp, signature, stringToSign };
}

/**
 * Make HTTP request to API
 */
function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, cfg.apiUrl);
    const isHttps = cfg.apiUrl.startsWith('https');
    const client = isHttps ? https : http;
    
    const { timestamp, signature } = generateSignature(method, path);
    
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: {
        'X-Vibe-Client-Id': cfg.clientId,
        'X-Vibe-Timestamp': timestamp,
        'X-Vibe-Signature': signature,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    if (accessToken) {
      options.headers['Authorization'] = `Bearer ${accessToken}`;
    }

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
 * Get bearer token via Internal Agent Auth
 */
async function getAgentToken() {
  log('🔐 Getting agent token via Internal Agent Auth...');
  log(`   User ID: ${USER_ID}`);
  
  const path = '/api/internal/agent-auth/token';
  
  // Note: This endpoint is on the IDP, not the API
  const url = new URL(path, cfg.idpUrl);
  const isHttps = cfg.idpUrl.startsWith('https');
  const client = isHttps ? https : http;
  
  const { timestamp, signature, stringToSign } = generateSignature('POST', path);
  
  log(`   String to sign: ${stringToSign}`);
  log(`   Signature: ${signature.substring(0, 40)}...`);
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'X-Vibe-Client-Id': cfg.clientId,
        'X-Vibe-Timestamp': timestamp,
        'X-Vibe-Signature': signature,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    const req = client.request(options, (res) => {
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
    req.write(JSON.stringify({ userId: USER_ID }));
    req.end();
  });
}

/**
 * Connect to SignalR hub
 */
async function connectSignalR() {
  log('\n📡 Connecting to SignalR hub...');
  log(`   URL: ${cfg.wsUrl}`);
  
  const connection = new HubConnectionBuilder()
    .withUrl(cfg.wsUrl, {
      accessTokenFactory: () => {
        log('🔑 Providing access token to SignalR');
        return accessToken;
      },
      transport: require('@microsoft/signalr').HttpTransportType.WebSockets
    })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .configureLogging(LogLevel.Information)
    .build();

  // Event handlers
  connection.on('ReceiveNotification', (notification) => {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📬 NEW MAIL RECEIVED!');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`From:    ${notification.senderAgentName || 'Unknown'}`);
    console.log(`To:      ${notification.recipientAgentName || 'Unknown'}`);
    console.log(`Subject: ${notification.subject || '(no subject)'}`);
    console.log(`Type:    ${notification.mailType || 'standard'}`);
    console.log(`Time:    ${new Date().toISOString()}`);
    if (notification.content) {
      console.log(`Content: ${notification.content.substring(0, 200)}${notification.content.length > 200 ? '...' : ''}`);
    }
    console.log('═══════════════════════════════════════════════════════════════\n');
  });

  connection.on('MailRead', (data) => {
    log(`📖 Mail marked as read: ${data.mailId}`);
  });

  connection.on('ConnectionAck', (data) => {
    log(`✅ Connected! Connection ID: ${data.connectionId}`);
    log(`   Subscribed agents: ${data.subscribedAgents?.join(', ') || 'none'}`);
  });

  connection.onreconnecting((error) => {
    log('🔄 Reconnecting...', error?.message || '');
  });

  connection.onreconnected((connectionId) => {
    log('✅ Reconnected! ID:', connectionId);
  });

  connection.onclose((error) => {
    log('❌ Connection closed', error ? `: ${error.message}` : '');
    process.exit(0);
  });

  await connection.start();
  
  // Subscribe to our agent
  log(`\n📝 Subscribing to agent: ${AGENT_NAME}`);
  await connection.invoke('SubscribeToAgent', AGENT_NAME);
  log('✅ Subscribed!');
  
  return connection;
}

/**
 * Send test message
 */
async function sendTestMessage() {
  log('\n📤 Sending test message...');
  
  const response = await apiRequest('POST', '/api/v1/agent/mail', {
    recipientAgentName: AGENT_NAME,
    subject: 'SignalR Test via Agent Auth',
    content: `Test message sent at ${new Date().toISOString()}`,
    mailType: 'standard',
    priority: 'normal',
    metadata: {
      source: 'agent-auth-test',
      testRun: true
    }
  });

  if (response.status === 200 || response.status === 201) {
    log('✅ Test message sent successfully!');
    if (response.data.data?.mailId) {
      log(`   Mail ID: ${response.data.data.mailId}`);
    }
  } else {
    log('❌ Failed to send message:', response.status);
    log('   Response:', JSON.stringify(response.data, null, 2));
  }
}

/**
 * Main function
 */
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  SignalR Test via Internal Agent Auth                         ║');
  console.log(`║  Environment: ${ENV.padEnd(49)}║`);
  console.log(`║  User ID: ${USER_ID.toString().padEnd(53)}║`);
  console.log(`║  Agent: ${AGENT_NAME.padEnd(55)}║`);
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log();

  try {
    // Step 1: Get bearer token via agent auth
    const tokenResponse = await getAgentToken();
    
    if (tokenResponse.status !== 200) {
      console.error('\n❌ Failed to get agent token:');
      console.error('   Status:', tokenResponse.status);
      console.error('   Response:', JSON.stringify(tokenResponse.data, null, 2));
      
      if (tokenResponse.status === 401) {
        console.error('\n💡 HMAC signature may be wrong. Check:');
        console.error('   - Client ID is correct');
        console.error('   - HMAC key is correct');
        console.error('   - String to sign format: timestamp|METHOD|/api/internal/agent-auth/token');
      }
      
      process.exit(1);
    }
    
    if (!tokenResponse.data.success) {
      console.error('\n❌ Agent auth failed:', tokenResponse.data.error?.message || 'Unknown error');
      process.exit(1);
    }
    
    accessToken = tokenResponse.data.data.accessToken;
    const expiresIn = tokenResponse.data.data.expiresIn;
    tokenExpiresAt = Date.now() + (expiresIn * 1000);
    
    log('\n✅ Got bearer token!');
    log(`   Expires in: ${expiresIn}s`);
    log(`   Token: ${accessToken.substring(0, 50)}...`);
    
    // Step 2: Connect to SignalR
    const connection = await connectSignalR();
    
    // Step 3: Send test message
    await sendTestMessage();
    
    // Step 4: Keep listening
    console.log('\n' + '═'.repeat(63));
    console.log('👂 Listening for notifications...');
    console.log('   Press Ctrl+C to exit');
    console.log('═'.repeat(63) + '\n');
    
    // Keep alive and refresh token if needed
    setInterval(async () => {
      const timeUntilExpiry = tokenExpiresAt - Date.now();
      
      // Refresh if expiring in less than 5 minutes
      if (timeUntilExpiry < 5 * 60 * 1000) {
        log('🔄 Token expiring soon, refreshing...');
        try {
          const newToken = await getAgentToken();
          if (newToken.status === 200 && newToken.data.success) {
            accessToken = newToken.data.data.accessToken;
            tokenExpiresAt = Date.now() + (newToken.data.data.expiresIn * 1000);
            log('✅ Token refreshed!');
          }
        } catch (err) {
          log('⚠️  Token refresh failed:', err.message);
        }
      }
    }, 60000); // Check every minute
    
  } catch (err) {
    console.error('\n💥 Fatal error:', err.message);
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
