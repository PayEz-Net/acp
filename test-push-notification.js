const { HubConnectionBuilder, LogLevel } = require('@microsoft/signalr');
const crypto = require('crypto');
const http = require('http');

const API_URL = 'http://10.0.0.220:32786';
const IDP_URL = 'http://10.0.0.93:32785';
const WS_URL = 'ws://10.0.0.220:32786/hubs/agentmail';
const CLIENT_ID = 'vibe_2577f53820d8436d';
const HMAC_KEY = 'fTgHIwYUWBAjh03SDhS6VK25ddHJ1v2ZIFyikG4LI0w=';
const AGENT_NAME = 'MarcuVale';

let accessToken = null;

function generateSignature(method, path) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = timestamp + '|' + method.toUpperCase() + '|' + path;
  const signature = crypto.createHmac('sha256', Buffer.from(HMAC_KEY, 'base64')).update(stringToSign).digest('base64');
  return { timestamp, signature };
}

async function idpRequest(method, path, body = null) {
  const url = new URL(path, IDP_URL);
  const { timestamp, signature } = generateSignature(method, path);
  
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: method.toUpperCase(),
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function startDeviceAuth() {
  console.log('🔐 Starting device code flow...');
  const res = await idpRequest('POST', '/api/ExternalAuth/agent-device/start', {
    client: 'ideal_resume_website',
    device_id: 'vibe_agents_no_acp'
  });
  
  if (res.status !== 200 || !res.data.success) {
    throw new Error('Failed to start: ' + JSON.stringify(res.data));
  }
  return res.data.data;
}

async function pollForToken(deviceCode, interval = 5) {
  console.log('⏳ Polling for authorization (max 60s)...');
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, interval * 1000));
    process.stdout.write(`Polling ${i + 1}/12...\r`);
    
    const res = await idpRequest('POST', '/api/ExternalAuth/agent-device/poll', {
      device_code: deviceCode,
      client: 'ideal_resume_website'
    });
    
    if (res.data.success && res.data.data?.access_token) {
      console.log('\n✅ Authorized!');
      return res.data.data.access_token;
    }
    if (res.data.data?.status === 'authorization_pending') continue;
    if (res.data.data?.status === 'expired') throw new Error('Expired');
    if (res.data.error?.code === 'SLOW_DOWN') {
      console.log('\n⏱️  Rate limited, waiting extra...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw new Error('Timeout');
}

async function connectSignalR() {
  console.log('\n📡 Connecting to SignalR...');
  
  const connection = new HubConnectionBuilder()
    .withUrl(`${API_URL}/hubs/agentmail`, {
      accessTokenFactory: () => accessToken
    })
    .withAutomaticReconnect([0, 2000, 5000, 10000])
    .configureLogging(LogLevel.Warning)
    .build();

  connection.on('ReceiveNotification', (n) => {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📬 PUSH NOTIFICATION RECEIVED!');
    console.log('Event:', n.event_type || 'unknown');
    console.log('From:', n.data?.from_agent_display || n.data?.from_agent || 'Unknown');
    console.log('To:', n.data?.to_agent || 'Unknown');
    console.log('Subject:', n.data?.subject || '(no subject)');
    console.log('Preview:', n.data?.preview?.substring(0, 100) + '...');
    console.log('Importance:', n.data?.importance || 'normal');
    console.log('Message ID:', n.data?.message_id);
    console.log('═══════════════════════════════════════════════════════════\n');
  });

  connection.on('ConnectionAck', (d) => console.log('✅ Connected! ID:', d.connectionId?.substring(0, 8)));
  connection.onreconnecting(() => console.log('🔄 Reconnecting...'));
  connection.onreconnected(() => console.log('✅ Reconnected!'));
  connection.onclose(() => { console.log('❌ Closed'); process.exit(0); });

  await connection.start();
  await connection.invoke('SubscribeToAgents', [AGENT_NAME]);
  console.log('✅ Subscribed to:', AGENT_NAME);
  return connection;
}

async function sendTestMail(conn) {
  console.log('\n📤 Sending test message to self...');
  const { timestamp, signature } = generateSignature('POST', '/v1/agentmail/send');
  
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '10.0.0.220',
      port: 32786,
      path: '/v1/agentmail/send',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'X-Vibe-Client-Id': CLIENT_ID,
        'X-Vibe-Timestamp': timestamp,
        'X-Vibe-Signature': signature,
        'X-Vibe-User-Id': '22',
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: data || '(empty)' }); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({
      from_agent: AGENT_NAME,
      to: [AGENT_NAME],
      subject: 'SignalR Test ' + new Date().toLocaleTimeString(),
      body: 'Testing push notifications!',
      priority: 'normal'
    }));
    req.end();
  });
  
  if (res.status === 201 || res.status === 200) {
    console.log('✅ Message sent!');
  } else {
    console.log('❌ Failed:', res.status);
    console.log('Response:', res.data);
  }
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  SignalR Push Notification Test                           ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  try {
    const { device_code, user_code, verification_url, interval } = await startDeviceAuth();
    console.log('\n📱 Device Code:');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('User Code:', user_code);
    console.log('URL:', verification_url);
    console.log('═══════════════════════════════════════════════════════════\n');
    
    accessToken = await pollForToken(device_code, interval);
    const conn = await connectSignalR();
    
    // Wait a moment then send test
    await new Promise(r => setTimeout(r, 1000));
    await sendTestMail(conn);
    
    console.log('\n👂 Listening for push notification (10s timeout)...\n');
    await new Promise(r => setTimeout(r, 10000));
    
    console.log('\n✅ Test complete!');
    await conn.stop();
    process.exit(0);
    
  } catch (err) {
    console.error('\n💥 Error:', err.message);
    process.exit(1);
  }
}

main();
