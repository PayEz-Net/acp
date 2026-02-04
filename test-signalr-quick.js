const crypto = require('crypto');
const http = require('http');

const API_URL = 'http://10.0.0.220:32786';
const CLIENT_ID = 'vibe_2577f53820d8436d';
const HMAC_KEY = 'fTgHIwYUWBAjh03SDhS6VK25ddHJ1v2ZIFyikG4LI0w=';

function generateSignature(method, path) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}|${method.toUpperCase()}|${path}`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(HMAC_KEY, 'base64'))
    .update(stringToSign)
    .digest('base64');
  return { timestamp, signature, stringToSign };
}

function testNegotiate() {
  return new Promise((resolve, reject) => {
    const path = '/hubs/agentmail/negotiate';
    const { timestamp, signature } = generateSignature('GET', path);
    
    const options = {
      hostname: '10.0.0.220',
      port: 32786,
      path: path,
      method: 'GET',
      headers: {
        'X-Vibe-Client-Id': CLIENT_ID,
        'X-Vibe-Timestamp': timestamp,
        'X-Vibe-Signature': signature,
        'Accept': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Response:', data.substring(0, 500));
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

console.log('Testing SignalR negotiate at', API_URL);
console.log('═══════════════════════════════════════════════════════════\n');
testNegotiate().then(result => {
  if (result.status === 200) {
    console.log('\n✅ SUCCESS! SignalR negotiate working!');
  } else if (result.status === 401) {
    console.log('\n❌ UNAUTHORIZED - Auth issue');
  } else if (result.status === 500) {
    console.log('\n❌ SERVER ERROR - Backend issue');
  } else {
    console.log('\n⚠️  Status:', result.status);
  }
}).catch(err => {
  console.error('\n💥 Error:', err.message);
});
