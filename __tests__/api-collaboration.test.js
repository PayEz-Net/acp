import { createApp } from '../api/server.js';

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

const authedRequest = () => request.agent(app).set('Authorization', 'Bearer test-secret');

// NOTE: Party + legacy /v1/messages route tests were removed — those surfaces were
// CUT (WO 8201): party feature deferred from v1, /v1/messages superseded by the cloud
// mail proxy at /v1/mail. They are intentionally gone, so there's nothing to assert.

describe('Kanban Routes — Validation', () => {
  test('POST /v1/kanban/tasks requires title', async () => {
    const res = await authedRequest()
      .post('/v1/kanban/tasks')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });
});

describe('Kanban Routes — Storage-dependent', () => {
  test('POST /v1/kanban/tasks returns error envelope on no DB', async () => {
    const res = await authedRequest()
      .post('/v1/kanban/tasks')
      .send({ title: 'Test Task' });
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('meta');
  });

  test('GET /v1/kanban/tasks returns error envelope on no DB', async () => {
    const res = await authedRequest().get('/v1/kanban/tasks');
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('meta');
  });
});

describe('Autonomy Routes — Storage-dependent', () => {
  test('GET /v1/autonomy/status returns error envelope on no DB', async () => {
    const res = await authedRequest().get('/v1/autonomy/status');
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('meta');
  });

  test('GET /v1/autonomy/standup returns error envelope on no DB', async () => {
    const res = await authedRequest().get('/v1/autonomy/standup');
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('meta');
  });
});

describe('Route Registration', () => {
  test('all collaboration routes are mounted (not 404)', async () => {
    const routes = [
      { method: 'post', path: '/v1/kanban/tasks', body: {} },
      { method: 'get', path: '/v1/kanban/tasks' },
      { method: 'get', path: '/v1/kanban/tasks/1' },
      { method: 'put', path: '/v1/kanban/tasks/1/status', body: {} },
      { method: 'put', path: '/v1/kanban/tasks/1/assign', body: {} },
      { method: 'put', path: '/v1/kanban/tasks/1/review', body: {} },
      { method: 'post', path: '/v1/autonomy/start', body: {} },
      { method: 'post', path: '/v1/autonomy/stop', body: {} },
      { method: 'get', path: '/v1/autonomy/status' },
      { method: 'get', path: '/v1/autonomy/standup' },
      { method: 'post', path: '/v1/autonomy/standup', body: {} },
    ];

    for (const route of routes) {
      const req = authedRequest()[route.method](route.path);
      if (route.body) req.send(route.body);
      const res = await req;
      expect(res.body.error?.code).not.toBe('NOT_FOUND');
    }
  });
});

describe('Empty List via Session Routes (file fallback works)', () => {
  test('sessions return 200 with empty array', async () => {
    const res = await authedRequest().get('/v1/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
