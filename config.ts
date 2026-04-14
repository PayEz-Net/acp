export const config = {
  port: parseInt(process.env.PORT ?? '', 10) || 3001,
  host: '127.0.0.1',
  idpUrl: process.env.IDP_URL || 'http://10.0.0.93:32785',  // External ID API (not internal 32774)
  vibeApiUrl: process.env.VIBE_API_URL || 'http://10.0.0.93:32786',
  vibeClientId: process.env.VIBE_CLIENT_ID || 'vibe_8834988b5d2843a2',
  vibeHmacKey: process.env.VIBE_HMAC_KEY || '2lTSxbTS6NrleZ2K9FjxPi9GvZHBczXUoHrk8sUUNGo=',
  vibeUserId: process.env.VIBE_USER_ID || '0',
  acpLocalSecret: process.env.ACP_LOCAL_SECRET || '',
  acpCallbackPort: parseInt(process.env.ACP_CALLBACK_PORT ?? '', 10) || 40030,
  acpAgents: (process.env.ACP_AGENTS || 'DotNetPert,BAPert,NextPert,QAPert,Aurum').split(',').map(a => a.trim()),
  acpAutoSpawn: process.env.ACP_AUTO_SPAWN === 'true',
  vibeTokenCmd: process.env.VIBE_TOKEN_CMD || './cli.js token',
  vibeTokenRefreshS: parseInt(process.env.VIBE_TOKEN_REFRESH_S ?? '', 10) || 300,
  vibeAuthMode: process.env.VIBE_AUTH_MODE || 'bearer',
  vibeSigningKey: process.env.VIBE_SIGNING_KEY || '',
  execTimeoutMs: parseInt(process.env.EXEC_TIMEOUT_MS ?? '', 10) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  redisUrl: process.env.REDIS_URL || 'redis://10.0.0.93:6379',
  corsOrigins: process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:40020',
  enableContractors: process.env.ENABLE_CONTRACTORS === 'true', // Disabled by default - not stable yet
  partyTickMs: parseInt(process.env.PARTY_TICK_MS ?? '', 10) || 5000,
  autonomyMaxRuntimeHours: parseInt(process.env.AUTONOMY_MAX_RUNTIME_HOURS ?? '', 10) || 4,
  escalationSensitivity: parseInt(process.env.ESCALATION_SENSITIVITY ?? '', 10) || 2,
  
  // Deprecated: VibeSQL config - kept for compatibility but not used
  vibesqlUrl: process.env.VIBESQL_URL || '',
  vibesqlDirectUrl: process.env.VIBESQL_DIRECT_URL || '',
  vibesqlContainerSecret: process.env.VIBESQL_CONTAINER_SECRET || '',
};

export type Config = typeof config;
