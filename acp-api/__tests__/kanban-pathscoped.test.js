// 117431 step 2: the path-scoped kanban surface (/v1/projects/:projectId/kanban/*) and its
// prefix gate (RULING A, BAPert 2026-08-11): bearer callers are answered by the cloud via
// storage.canSeeProject (200 allow / 404 deny-read / 403 deny-write); X-ACP-Agent callers
// bypass exactly as today (agent scoping = card 210601). Bare express + fake storage —
// what is under test is the ROUTER's addressing and the gate, not the app wiring.
import { jest } from '@jest/globals';
import express from 'express';
import kanbanRoutes from '../api/routes/kanban.js';
import { statusForCode } from '../api/response.js';

function fakeStorage(overrides = {}) {
  return {
    getActiveProjectId: jest.fn(async () => 31),
    getProject: jest.fn(async () => ({ status: 'active' })),
    listTasks: jest.fn(async () => [{ id: 1, title: 't' }]),
    createTask: jest.fn(async () => 900),
    getTask: jest.fn(async () => ({ id: 1, title: 't' })),
    updateTask: jest.fn(async () => ({ id: 1 })),
    canSeeProject: jest.fn(async () => true),
    appendKanbanActivity: jest.fn(async () => 1),
    ...overrides,
  };
}

// auth shim standing in for localAuth: 'x-test-auth: bearer|agent' sets what localAuth would.
function makeApp(storage) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const mode = req.headers['x-test-auth'];
    if (mode === 'bearer') { req.authMethod = 'bearer'; req.agentName = 'jon'; }
    if (mode === 'agent') { req.authMethod = 'agent'; req.agentName = 'Nextpert-Scout'; }
    req.startTime = performance.now();
    next();
  });
  app.use('/v1/projects/:projectId/kanban', kanbanRoutes(storage, undefined, { pathScoped: true }));
  app.use((err, _req, res, _next) => {
    res.status(statusForCode(err.code)).json({ success: false, error: { code: err.code, message: err.message } });
  });
  return app;
}

let request;
beforeAll(async () => {
  request = (await import('supertest')).default;
});

describe('117431 path-scoped kanban: addressing', () => {
  test('GET /v1/projects/12/kanban/tasks lists project 12, NOT the active project', async () => {
    const storage = fakeStorage();
    const res = await request(makeApp(storage)).get('/v1/projects/12/kanban/tasks').set('x-test-auth', 'bearer');
    expect(res.status).toBe(200);
    expect(storage.listTasks.mock.calls[0][0].projectId).toBe(12);
    expect(storage.getActiveProjectId).not.toHaveBeenCalled();
  });

  test('POST create lands on the PATH project (the 204645 acceptance shape)', async () => {
    const storage = fakeStorage();
    const res = await request(makeApp(storage))
      .post('/v1/projects/12/kanban/tasks')
      .set('x-test-auth', 'bearer')
      .send({ title: 'filed on 12' });
    expect(res.status).toBe(200);
    expect(storage.createTask.mock.calls[0][1]).toBe(12);
  });

  test('garbage path id -> 400, never a silent fall back to ambient scope', async () => {
    const storage = fakeStorage();
    const res = await request(makeApp(storage)).get('/v1/projects/abc/kanban/tasks').set('x-test-auth', 'bearer');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
    expect(storage.listTasks).not.toHaveBeenCalled();
  });

  test('?project_id= is still rejected even on the addressed route (one shape only)', async () => {
    const storage = fakeStorage();
    const res = await request(makeApp(storage)).get('/v1/projects/12/kanban/tasks?project_id=12').set('x-test-auth', 'bearer');
    expect(res.status).toBe(400);
  });
});

describe('117431 prefix gate (RULING A)', () => {
  test('bearer + cloud says visible -> allowed', async () => {
    const storage = fakeStorage({ canSeeProject: jest.fn(async () => true) });
    const res = await request(makeApp(storage)).get('/v1/projects/12/kanban/tasks').set('x-test-auth', 'bearer');
    expect(res.status).toBe(200);
    expect(storage.canSeeProject).toHaveBeenCalledWith(12);
  });

  test('bearer + cloud says NOT visible -> read 404 (existence-hiding)', async () => {
    const storage = fakeStorage({ canSeeProject: jest.fn(async () => false) });
    const res = await request(makeApp(storage)).get('/v1/projects/12/kanban/tasks').set('x-test-auth', 'bearer');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(storage.listTasks).not.toHaveBeenCalled();
  });

  test('bearer + cloud says NOT visible -> write 403 (named write denial)', async () => {
    const storage = fakeStorage({ canSeeProject: jest.fn(async () => false) });
    const res = await request(makeApp(storage))
      .post('/v1/projects/12/kanban/tasks')
      .set('x-test-auth', 'bearer')
      .send({ title: 'nope' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(storage.createTask).not.toHaveBeenCalled();
  });

  test('agent caller BYPASSES the gate exactly as today (no regression; card 210601 owns the lane)', async () => {
    const canSeeProject = jest.fn(async () => { throw new Error('must not be called for agent callers'); });
    const storage = fakeStorage({ canSeeProject });
    const res = await request(makeApp(storage)).get('/v1/projects/12/kanban/tasks').set('x-test-auth', 'agent');
    expect(res.status).toBe(200);
    expect(canSeeProject).not.toHaveBeenCalled();
  });

  test('a resolve FAILURE surfaces as an error, never fail-open', async () => {
    const storage = fakeStorage({ canSeeProject: jest.fn(async () => { throw new Error('cloud unreachable'); }) });
    const res = await request(makeApp(storage)).get('/v1/projects/12/kanban/tasks').set('x-test-auth', 'bearer');
    expect(res.status).toBe(500);
    expect(storage.listTasks).not.toHaveBeenCalled();
  });
});
