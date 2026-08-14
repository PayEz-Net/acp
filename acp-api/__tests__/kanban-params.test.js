// 117431 step 3 + 121194: the kanban list/create routes must REJECT project_id loudly and
// 400 garbage paging params — accepted-and-ignored is the defect class this cluster exists
// to close. These fire BEFORE storage is touched, so the dead-DB harness suffices.
// Must-fail-first: at HEAD-before-fix both project_id requests returned 2xx (201 create on
// the ACTIVE project; 200 list of the ACTIVE project) — proven live by probe card 204645.

process.env.IDP_URL ||= 'http://127.0.0.1:9';
process.env.VIBE_API_URL ||= 'http://127.0.0.1:9';

let request;
let app;

beforeAll(async () => {
  const supertest = await import('supertest');
  const { createApp } = await import('../api/server.js');
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

describe('117431 step 3: project_id rejected, never accepted-and-ignored', () => {
  test('GET /v1/kanban/tasks?project_id=12 -> 400 naming the path-scoped shape', async () => {
    const res = await authedRequest().get('/v1/kanban/tasks?project_id=12');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
    expect(res.body.error.message).toMatch(/\/v1\/projects\/\{id\}\/kanban\/tasks/);
  });

  test('GET /v1/kanban/tasks?projectId=12 (camel) -> 400 too', async () => {
    const res = await authedRequest().get('/v1/kanban/tasks?projectId=12');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  test('POST /v1/kanban/tasks with project_id -> 400 naming the two real shapes', async () => {
    const res = await authedRequest()
      .post('/v1/kanban/tasks')
      .send({ title: 'should not be created', project_id: 12 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
    expect(res.body.error.message).toMatch(/projects\/current/);
  });
});
