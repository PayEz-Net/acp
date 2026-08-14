// #117431: kanban create/list must HONOUR a client-supplied project id or REJECT
// loudly (400) — never silently substitute the active project. Mounts kanbanRoutes
// directly over a mock storage so project resolution is exercised without a DB.
import express from 'express';
import kanbanRoutes from '../api/routes/kanban.js';

let request;
let app;
let createdCalls;
let listFilters;

const PROJECTS = {
  1: { id: 1, status: 'active' },
  2: { id: 2, status: 'active' },
  3: { id: 3, status: 'archived' },
};

const storage = {
  getActiveProjectId: async () => 1,
  getProject: async (id) => PROJECTS[id] ?? null,
  createTask: async (task, projectId) => {
    createdCalls.push({ task, projectId });
    return 100 + createdCalls.length;
  },
  listTasks: async (filter) => {
    listFilters.push({ ...filter });
    return [{ id: 7, title: 'probe', projectId: filter.projectId ?? null }];
  },
};

beforeAll(async () => {
  const supertest = await import('supertest');
  request = supertest.default;
  app = express();
  app.use(express.json());
  app.use('/v1/kanban', kanbanRoutes(storage));
});

beforeEach(() => {
  createdCalls = [];
  listFilters = [];
});

describe('Kanban #117431 — POST /tasks honours project_id', () => {
  test('create with explicit project_id lands on THAT project', async () => {
    const res = await request(app)
      .post('/v1/kanban/tasks')
      .send({ title: 'Card for project 2', project_id: 2 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(createdCalls).toHaveLength(1);
    expect(createdCalls[0].projectId).toBe(2);
  });

  test('create also accepts camelCase projectId', async () => {
    const res = await request(app)
      .post('/v1/kanban/tasks')
      .send({ title: 'Card for project 2', projectId: 2 });
    expect(res.status).toBe(200);
    expect(createdCalls[0].projectId).toBe(2);
  });

  test('create with unknown project_id -> 400 PROJECT_NOT_FOUND, nothing created', async () => {
    const res = await request(app)
      .post('/v1/kanban/tasks')
      .send({ title: 'Card for nowhere', project_id: 999 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
    expect(createdCalls).toHaveLength(0);
  });

  test('create with malformed project_id -> 400 VALIDATION_ERROR, nothing created', async () => {
    const res = await request(app)
      .post('/v1/kanban/tasks')
      .send({ title: 'Bad id', project_id: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(createdCalls).toHaveLength(0);
  });

  test('create targeting an ARCHIVED project -> 403 PROJECT_ARCHIVED', async () => {
    const res = await request(app)
      .post('/v1/kanban/tasks')
      .send({ title: 'Into the archive', project_id: 3 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROJECT_ARCHIVED');
    expect(createdCalls).toHaveLength(0);
  });

  test('create without project_id still falls back to the active project (regression)', async () => {
    const res = await request(app)
      .post('/v1/kanban/tasks')
      .send({ title: 'Default board card' });
    expect(res.status).toBe(200);
    expect(createdCalls).toHaveLength(1);
    expect(createdCalls[0].projectId).toBe(1);
  });
});

describe('Kanban #117431 — GET /tasks honours project_id', () => {
  test('list with project_id returns that project board', async () => {
    const res = await request(app).get('/v1/kanban/tasks?project_id=2');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(listFilters).toHaveLength(1);
    expect(listFilters[0].projectId).toBe(2);
  });

  test('list also accepts camelCase projectId', async () => {
    const res = await request(app).get('/v1/kanban/tasks?projectId=2');
    expect(res.status).toBe(200);
    expect(listFilters[0].projectId).toBe(2);
  });

  test('list with unknown project_id -> 400 PROJECT_NOT_FOUND', async () => {
    const res = await request(app).get('/v1/kanban/tasks?project_id=999');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
    expect(listFilters).toHaveLength(0);
  });

  test('list without project_id still falls back to the active project (regression)', async () => {
    const res = await request(app).get('/v1/kanban/tasks');
    expect(res.status).toBe(200);
    expect(listFilters[0].projectId).toBe(1);
  });
});
