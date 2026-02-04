#!/usr/bin/env node
/**
 * Quick SignalR Negotiate Test
 * Tests the negotiate endpoint with HMAC auth
 * 
 * Usage: node test-negotiate.js [dev|prod]
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const ENV = process.argv[2] || 'dev';
const IS_PROD = ENV === 'prod';

const CONFIG = {
  dev: {
    apiUrl: 'http://10.0.0.93:32786',
    clientId: 'vibe_2577f53820d8436d',
    hmacKey: 'fTgHIwYUWBAjh03SDhS6VK25ddHJ1v2ZIFyikG4LI0w='
  },
  prod: {
    apiUrl: 'https://api.idealvibe.online',
    clientId: 'vibe_b2d2aac0315549d9',
    hmacKey: 'KAG7vjumrWhx4CHtPSNcowYzjkbeVZmSitD8xjdZXkw='
  }
};

const cfg = CONFIG[IS_PROD ? 'prod' : 'dev'];

// Generate HMAC signature
function generateSignature(method, path) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}|${method.toUpperCase()}|${path}`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(cfg.hmacKey, 'base64'))
    .update(stringToSign)
    .digest('base64');
  return { timestamp, signature, stringToSign };
}

// Make HTTP request
function makeRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const urlObj = new URL(url);
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });

    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SignalR Negotiate Test');
  console.log(`  Environment: ${ENV}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  const path = '/hubs/agentmail/negotiate';
  const url = `${cfg.apiUrl}${path}`;
  const { timestamp, signature, stringToSign } = generateSignature('GET', path);

  console.log('Client ID:  ', cfg.clientId);
  console.log('Timestamp:  ', timestamp);
  console.log('String:     ', stringToSign);
  console.log('Signature:  ', signature.substring(0, 50) + '...\n');
  console.log('Requesting: ', url, '\n');

  const headers = {
    'X-Vibe-Client-Id': cfg.clientId,
    'X-Vibe-Timestamp': timestamp,
    'X-Vibe-Signature': signature,
    'Accept': 'application/json'
  };

  try {
    const { status, data } = await makeRequest(url, headers);
    
    console.log('Response Code:', status);
    console.log('Response Body:');
    
    try {
      const json = JSON.parse(data);
      console.log(JSON.stringify(json, null, 2));
    } catch {
      console.log(data);
    }

    console.log('\n' + '═'.repeat(63));
    
    if (status === 200) {
      console.log('✅ SUCCESS! SignalR negotiate endpoint is working');
      console.log('   Connection URL should be in the response');
      process.exit(0);
    } else if (status === 401) {
      console.log('❌ UNAUTHORIZED (401)');
      console.log('   Check HMAC signature format: timestamp|METHOD|path');
      process.exit(1);
    } else if (status === 403) {
      console.log('❌ FORBIDDEN (403)');
      console.log('   Valid auth but not authorized for this hub');
      process.exit(1);
    } else if (status === 404) {
      console.log('❌ NOT FOUND (404)');
      console.log('   Hub endpoint does not exist');
      process.exit(1);
    } else if (status === 500) {
      console.log('❌ SERVER ERROR (500)');
      console.log('   Backend issue - check server logs');
      process.exit(1);
    } else {
      console.log(`⚠️  Unexpected response (${status})`);
      process.exit(1);
    }
    
  } catch (err) {
    console.error('\n💥 Request failed:', err.message);
    process.exit(1);
  }
}

main();
