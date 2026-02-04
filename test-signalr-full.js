const { HubConnectionBuilder, LogLevel } = require('@microsoft/signalr');
const crypto = require('crypto');
const http = require('http');

const API_URL = 'http://10.0.0.220:32786';
const WS_URL = 'ws://10.0.0.220:32786/hubs/agentmail';
const IDP_URL = 'http://10.0.0.220:32785';
const CLIENT_ID = 'vibe_2577f53820d8436d';
const HMAC_KEY = 'fTgHIwYUWBAjh03SDhS6VK25ddHJ1v2ZIFyikG4LI0w=';
const AGENT_NAME = 'MarcuVale';

let accessToken = null;

function generateSignature(method, path) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = timestamp + '|' + method.toUpperCase() + '|' + path;
  const signature = crypto.createHmac('sha256', Buffer.from(HMAC_KEY, 'base64')).update(stringToSign).digest('base64');
  return { timestamp, signature, stringToSign };
}

async function apiRequest(method, path, body = null, useIdp = false) {
  const url = new URL(path, useIdp ? IDP_URL : API_URL);
  const { timestamp, signature } = generateSignature(method, path);
  
  return new Promise((resolve, reject) => {
    const req = http.request({
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
    }, (res) => {
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

async function startDeviceAuth() {
  console.log('🔐 Starting device code flow...');
  const path = '/api/v1/auth/device/code';
  const { timestamp, signature } = generateSignature('POST', path);
  
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '10.0.0.220',
      port: 32786,
      path: path,
      method: 'POST',
      headers: {
        'X-Vibe-Client-Id': CLIENT_ID,
        'X-Vibe-Timestamp': timestamp,
        'X-Vibe-Signature': signature,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({
      clientId: CLIENT_ID,
      deviceId: 'vibe_agents_no_acp',
      scopes: ['agent:mail', 'agent:read']
    }));
    req.end();
  });
  
  if (res.status !== 200 || !res.data.success) {
    throw new Error('Failed to start device flow: ' + JSON.stringify(res.data));
  }
  
  return res.data.data;
}

async function pollForToken(deviceCode, interval) {
  console.log('⏳ Polling for authorization...');
  const maxAttempts = 60;
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, interval * 1000));
    process.stdout.write(`Polling ${i + 1}/${maxAttempts}...\r`);
    
    try {
      const res = await apiRequest('POST', '/api/Auth/device/token', { deviceCode }, true);
      const data = res.data.data || res.data;
      
      if (data.access_token) {
        console.log('\n✅ Authorized!');
        return data.access_token;
      }
      if (data.status === 'authorization_pending') continue;
      if (data.status === 'expired_token') throw new Error('Code expired');
      if (data.error) throw new Error(data.error);
    } catch (err) {
      if (err.message.includes('expired') || err.message.includes('error')) throw err;
    }
  }
  throw new Error('Timeout');
}

async function connectSignalR() {
  console.log('\n📡 Connecting to SignalR...');
  
  const connection = new HubConnectionBuilder()
    .withUrl(WS_URL, {
      accessTokenFactory: () => accessToken,
      transport: require('@microsoft/signalr').HttpTransportType.WebSockets
    })
    .withAutomaticReconnect([0, 2000, 5000, 10000])
    .configureLogging(LogLevel.Information)
    .build();

  connection.on('ReceiveNotification', (n) => {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📬 NEW MAIL RECEIVED!');
    console.log('From:', n.senderAgentName || 'Unknown');
    console.log('To:', n.recipientAgentName || 'Unknown');
    console.log('Subject:', n.subject || '(no subject)');
    console.log('═══════════════════════════════════════════════════════════\n');
  });

  connection.on('ConnectionAck', (d) => {
    console.log('✅ Connected! Connection ID:', d.connectionId);
  });

  connection.onreconnecting(() => console.log('🔄 Reconnecting...'));
  connection.onreconnected(() => console.log('✅ Reconnected!'));
  connection.onclose(() => {
    console.log('❌ Connection closed');
    process.exit(0);
  });

  await connection.start();
  await connection.invoke('SubscribeToAgent', AGENT_NAME);
  console.log('✅ Subscribed to agent:', AGENT_NAME);
  
  return connection;
}

async function sendTestMail() {
  console.log('\n📤 Sending test message...');
  const res = await apiRequest('POST', '/api/v1/agent/mail', {
    recipientAgentName: AGENT_NAME,
    subject: 'SignalR Test ' + new Date().toLocaleTimeString(),
    content: 'This is a test message from SignalR!',
    mailType: 'standard',
    priority: 'normal'
  });
  
  if (res.status === 200 || res.status === 201) {
    console.log('✅ Test message sent!');
  } else {
    console.log('❌ Failed:', res.status, res.data);
  }
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  SignalR Full Test - Device Code Flow                     ║');
  console.log('║  API: http://10.0.0.220:32786                             ║');
  console.log('║  Agent: ' + AGENT_NAME.padEnd(50) + '║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  try {
    const { deviceCode, userCode, verificationUri, interval } = await startDeviceAuth();
    
    console.log('\n📱 Device Code Flow Started');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('User Code:', userCode);
    console.log('URL:', verificationUri);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('\n👉 Open the URL and enter the code to authorize\n');
    
    accessToken = await pollForToken(deviceCode, interval);
    
    const conn = await connectSignalR();
    
    await sendTestMail();
    
    console.log('\n👂 Listening for notifications (Ctrl+C to exit)...\n');
    
  } catch (err) {
    console.error('\n💥 Error:', err.message);
    process.exit(1);
  }
}

main();
