import { createApp } from '../api/server.js';

// Agent self-report status — POST /v1/status (comprehensive-installer-v1 §4).
// Covers QA cert §8.3.2 (positive working/idle), §8.3.6 (bad input -> 400, no default),
// and the identity guard. Default-idle-on-NO-report is a renderer concern (NextPert) and
// is not exercised here — this suite proves the endpoint contract.

let request;
let app;

beforeAll(async () => {
  const supertest = await import('supertest');
  request = supertest.default;
  app = await createApp({
    vibesqlUrl: 'http://localhost:0',
    vibeApiUrl: 'http://localhost:0',
    vibeClientId: 1,
    vibeTokenCmd: 'echo {}',
    vibeTokenRefreshS: 300,
    vibeAuthMode: 'bearer',
    vibeSigningKey: '',
    execTimeoutMs: 5000,
    nodeEnv: 'test',
    logLevel: 'error',
    corsOrigins: '*',
    partyTickMs: 999999,
    autonomyMaxRuntimeHours: 4,
    escalationSensitivity: 2,
    acpLocalSecret: 'test-secret',
    port: 0,
  });
});

// Bearer (test-secret) takes auth precedence and adopts X-ACP-Agent as the identity, so we can
// drive a real agent identity in-test without a roster-backed getAgentRegistration (AC-8 / localAuth).
const asAgent = (name) =>
  request(app).post('/v1/status').set('Authorization', 'Bearer test-secret').set('X-ACP-Agent', name);

describe('POST /v1/status — agent self-report', () => {
  test('valid working report -> 200, echoes agent + status + note', async () => {
    const res = await asAgent('DotNetPert').send({ status: 'working', note: 'building /v1/status' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.agent).toBe('DotNetPert');
    expect(res.body.data.status).toBe('working');
    expect(res.body.data.note).toBe('building /v1/status');
  });

  test('valid idle report -> 200 (note optional -> null)', async () => {
    const res = await asAgent('DotNetPert').send({ status: 'idle' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('idle');
    expect(res.body.data.note).toBeNull();
  });

  test('accepts the full AgentStatus enum (e.g. blocked)', async () => {
    const res = await asAgent('DotNetPert').send({ status: 'blocked', note: 'waiting on QA cert' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('blocked');
  });

  test('UNKNOWN status -> 400, NOT defaulted to idle (no silent fallback)', async () => {
    const res = await asAgent('DotNetPert').send({ status: 'busy' }); // legacy/out-of-enum
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_STATUS');
  });

  test('MISSING status -> 400 (bad input, not absence)', async () => {
    const res = await asAgent('DotNetPert').send({ note: 'no status field' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
  });

  test('no agent identity (Bearer only -> "system") -> 400', async () => {
    const res = await request(app)
      .post('/v1/status')
      .set('Authorization', 'Bearer test-secret')
      .send({ status: 'working' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });
});
