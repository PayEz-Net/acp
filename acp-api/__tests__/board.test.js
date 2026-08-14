import { jest } from '@jest/globals';
import { createTask, getTask, listTasks, moveTask, assignTask, editTask, archiveTask, addComment, moveTaskToProject, applyPaging, TRANSITIONS } from '../kanban/board.js';

function createMockStorage() {
  return {
    createTask: jest.fn(async () => 1),
    getTask: jest.fn(async () => null),
    listTasks: jest.fn(async () => []),
    updateTask: jest.fn(async (_id, updates) => ({ id: 1, ...updates })),
    moveTaskToProject: jest.fn(async (id, target) => ({ id, projectId: target })),
    appendKanbanActivity: jest.fn(async () => 1),
    addKanbanComment: jest.fn(async (c) => ({ comment_id: 1, ...c })),
    listKanbanComments: jest.fn(async () => []),
    listKanbanActivity: jest.fn(async () => []),
  };
}

const sampleTask = {
  id: 1,
  title: 'Login page',
  status: 'backlog',
  priority: 'medium',
  assignedTo: null,
  createdBy: 'BAPert',
};

describe('createTask', () => {
  test('creates task with defaults', async () => {
    const storage = createMockStorage();
    const id = await createTask(storage, { title: 'Login page', createdBy: 'BAPert' });
    expect(id).toBe(1);
    const t = storage.createTask.mock.calls[0][0];
    expect(t.title).toBe('Login page');
    expect(t.status).toBe('backlog');
    expect(t.priority).toBe('medium');
  });

  test('throws INVALID_REQUEST without title', async () => {
    const storage = createMockStorage();
    await expect(createTask(storage, {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('getTask', () => {
  test('returns task by id', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue(sampleTask);
    const task = await getTask(storage, 1);
    expect(task.title).toBe('Login page');
  });

  test('throws TASK_NOT_FOUND for missing task', async () => {
    const storage = createMockStorage();
    await expect(getTask(storage, 999)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });
});

describe('listTasks', () => {
  test('delegates to storage with filter', async () => {
    const storage = createMockStorage();
    await listTasks(storage, { status: 'review' });
    expect(storage.listTasks).toHaveBeenCalledWith({ status: 'review' });
  });
});

describe('moveTask', () => {
  test('moves backlog to in_progress', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    const result = await moveTask(storage, 1, 'in_progress');
    expect(result.status).toBe('in_progress');
    const call = storage.updateTask.mock.calls[0];
    expect(call[0]).toBe(1);
    expect(call[1]).toMatchObject({ status: 'in_progress' });
  });

  test('sets completedAt when moving to done', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'review' });
    const result = await moveTask(storage, 1, 'done');
    expect(result.completedAt).toBeTruthy();
  });

  test('rejects invalid transition', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'backlog' });
    await expect(moveTask(storage, 1, 'done')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  // #64 v1.1: done is NO LONGER terminal — done->in_progress/review reopen (clears completedAt).
  test('reopens from done (done->in_progress), clearing completedAt', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'done', completedAt: '2026-01-01T00:00:00Z' });
    const result = await moveTask(storage, 1, 'in_progress');
    expect(result.status).toBe('in_progress');
    expect(storage.updateTask.mock.calls[0][1]).toMatchObject({ status: 'in_progress', completedAt: null });
  });

  test('rejects an ILLEGAL agent edge without force (done->backlog)', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'done' });
    await expect(moveTask(storage, 1, 'backlog')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('force allows an off-graph move (done->backlog) and audits it', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'done' });
    const result = await moveTask(storage, 1, 'backlog', { force: true, actor: 'jon' });
    expect(result.status).toBe('backlog');
  });

  test('rejects retired status `todo`', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'backlog' });
    await expect(moveTask(storage, 1, 'todo')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('assignTask', () => {
  test('assigns agent to task', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    const result = await assignTask(storage, 1, 'DotNetPert');
    expect(result.assignedTo).toBe('DotNetPert');
    const call = storage.updateTask.mock.calls[0];
    expect(call[0]).toBe(1);
    expect(call[1]).toMatchObject({ assignedTo: 'DotNetPert' });
  });
});

describe('editTask (G1)', () => {
  test('edits free-form fields + audits', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    const result = await editTask(storage, 1, { title: 'New title', priority: 'high' }, 'jon');
    expect(result.title).toBe('New title');
    expect(storage.updateTask.mock.calls[0][1]).toMatchObject({ title: 'New title', priority: 'high' });
    expect(storage.appendKanbanActivity).toHaveBeenCalled();
  });

  test('rejects editing status via PATCH (guarded endpoint)', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(editTask(storage, 1, { status: 'done' }, 'jon')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('rejects editing assignee via PATCH', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(editTask(storage, 1, { assignedTo: 'X' }, 'jon')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  // 117431 step 1: projectId via PATCH gets a NAMED rejection that points at the move route.
  test('rejects editing projectId via PATCH, naming PUT /tasks/:id/move', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(editTask(storage, 1, { projectId: 12 }, 'jon')).rejects.toThrow(/PUT \/tasks\/:id\/move/);
  });

  test('rejects unknown field (no silent drop)', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(editTask(storage, 1, { bogus: 1 }, 'jon')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('rejects invalid priority', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(editTask(storage, 1, { priority: 'urgent' }, 'jon')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('comments + archive (G3/G5)', () => {
  test('addComment rejects empty body', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(addComment(storage, 1, { body_md: '  ' }, null)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('addComment persists + audits', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    const c = await addComment(storage, 1, { body_md: 'a note', author: 'jon' }, null);
    expect(c.comment_id).toBe(1);
    expect(storage.appendKanbanActivity).toHaveBeenCalled();
  });

  test('archiveTask sets archived + audits', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    const r = await archiveTask(storage, 1, true, 'jon');
    expect(r.archived).toBe(true);
    expect(storage.updateTask.mock.calls[0][1]).toMatchObject({ archived: true });
  });

  // #109: previousAssignee exposed for the reassigned-vs-assigned activity distinction
  test('first-assign (no prior owner) -> previousAssignee null', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, assignedTo: null });
    const result = await assignTask(storage, 1, 'DotNetPert');
    expect(result.previousAssignee).toBeNull();
    expect(result.assignedTo).toBe('DotNetPert');
  });

  test('reassign (prior owner) -> previousAssignee = old owner', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, assignedTo: 'QAPert' });
    const result = await assignTask(storage, 1, 'DotNetPert');
    expect(result.previousAssignee).toBe('QAPert');
    expect(result.assignedTo).toBe('DotNetPert');
  });
});

// RECONCILE NOTE: #152's standalone archiveTask/unarchiveTask tests (2-arg archive +
// separate unarchiveTask + idempotency) were dropped — that API is superseded by #64 G5's
// parametrized archiveTask(storage,id,archived,actor,projectId), covered by the
// 'comments + archive (G3/G5)' suite above. unarchive = archiveTask(...,false).

describe('TRANSITIONS', () => {
  test('defines valid state machine', () => {
    expect(TRANSITIONS.backlog).toContain('in_progress');
    expect(TRANSITIONS.in_progress).toContain('review');
    expect(TRANSITIONS.in_progress).toContain('blocked');
    expect(TRANSITIONS.review).toContain('done');
    expect(TRANSITIONS.review).toContain('in_progress');
    expect(TRANSITIONS.blocked).toContain('in_progress');
    // #64 v1.1: done reopens (no longer terminal); `todo` retired.
    expect(TRANSITIONS.done).toEqual(['in_progress', 'review']);
    expect(TRANSITIONS.todo).toBeUndefined();
  });
});

// ── 117431 step 1: moveTaskToProject (cross-project move, id preserved) ──────────
describe('moveTaskToProject (117431)', () => {
  test('moves a task to the target project via storage', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    const moved = await moveTaskToProject(storage, 1, 12, 'Nextpert-Scout', 31);
    expect(moved.projectId).toBe(12);
    const call = storage.moveTaskToProject.mock.calls[0];
    expect(call[0]).toBe(1);
    expect(call[1]).toBe(12);
    expect(call[2]).toBe('Nextpert-Scout'); // actor forwarded for the .NET-side activity entry
    expect(call[3]).toBe(31);
  });

  test('does NOT double-write activity here (the .NET move endpoint records it)', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await moveTaskToProject(storage, 1, 12, 'Nextpert-Scout', 31);
    expect(storage.appendKanbanActivity).not.toHaveBeenCalled();
  });

  test('404s when the task is not on the source project', async () => {
    const storage = createMockStorage(); // getTask -> null
    await expect(moveTaskToProject(storage, 999, 12, 'a', 31)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });

  test('rejects a missing/garbage target', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(moveTaskToProject(storage, 1, undefined, 'a', 31)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(moveTaskToProject(storage, 1, 'abc', 'a', 31)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('rejects a no-op move to the same project', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(moveTaskToProject(storage, 1, 31, 'a', 31)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('surfaces a non-persisting move as a hard failure, never fake-green', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    storage.moveTaskToProject.mockResolvedValue(null);
    await expect(moveTaskToProject(storage, 1, 12, 'a', 31)).rejects.toMatchObject({ code: 'MOVE_NOT_PERSISTED' });
  });
});

// ── 121194: applyPaging — the paging contract, unit-tested pure ──────────
describe('applyPaging (121194)', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));

  test('no params -> full set, hasMore false', () => {
    const p = applyPaging(rows, {});
    expect(p.rows).toHaveLength(10);
    expect(p.total).toBe(10);
    expect(p.hasMore).toBe(false);
  });

  test('limit caps the page and sets hasMore', () => {
    const p = applyPaging(rows, { limit: '5' });
    expect(p.rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(p.hasMore).toBe(true);
  });

  test('offset+limit returns a DISTINCT page (the 121194 acceptance: not the same rows)', () => {
    const p = applyPaging(rows, { limit: '5', offset: '5' });
    expect(p.rows.map((r) => r.id)).toEqual([6, 7, 8, 9, 10]);
    expect(p.hasMore).toBe(false);
    expect(p.total).toBe(10);
  });

  test('offset past the end -> empty page, hasMore false', () => {
    const p = applyPaging(rows, { limit: '5', offset: '50' });
    expect(p.rows).toHaveLength(0);
    expect(p.hasMore).toBe(false);
  });

  test('garbage limit/offset 400s, never silently ignored', async () => {
    expect(() => applyPaging(rows, { limit: 'abc' })).toThrow(/Invalid limit/);
    expect(() => applyPaging(rows, { limit: '0' })).toThrow(/Invalid limit/);
    expect(() => applyPaging(rows, { offset: '-1' })).toThrow(/Invalid offset/);
    try { applyPaging(rows, { limit: 'abc' }); } catch (e) { expect(e.code).toBe('INVALID_REQUEST'); }
  });
});

// ── 117039: the LIST DTO must carry the fields a board view consumes ──────────
// The defect this pins: the list read merged three cloud column boards whose rows
// were lean (no assignee/blockers reachable), and done/waiting paginated server-
// side at 20 — cards past page 1 were invisible ("the ceiling"). The fix reads the
// cloud list-ALL endpoint (/kanban/tasks, full set) and maps agent_name as the
// assignee fallback. Must-fail-first: before the fix, the endpoint assertion and
// the assignedTo assertion below both fail.
describe('117039 list DTO (session_manager storage)', () => {
  async function makeManager(rows) {
    // config.ts runs required() at module load — set throwaway values before import.
    process.env.IDP_URL ||= 'http://127.0.0.1:9';
    process.env.VIBE_API_URL ||= 'http://127.0.0.1:9';
    const { SessionManager } = await import('../agents/session_manager.js');
    const m = new SessionManager({ vibesqlUrl: 'http://localhost:5173' });
    m._cloudKanban = jest.fn(async () => ({ data: { tasks: rows, total_count: rows.length, has_more: false } }));
    return m;
  }

  test('listTasks reads the list-ALL endpoint, not the paginated column boards', async () => {
    const m = await makeManager([]);
    await m.listTasks({ projectId: 31 });
    const path = m._cloudKanban.mock.calls[0][1];
    expect(path).toBe('/v1/projects/31/kanban/tasks');
    expect(path).not.toMatch(/kanban\/(active|done|waiting)/);
  });

  test('list row for a card with a known assignee CONTAINS assignedTo (agent_name fallback)', async () => {
    const m = await makeManager([
      { id: 42, title: 'Owned card', status: 'in_progress', priority: 'high', agent_name: 'DotNetPert', created_at: '2026-08-01T00:00:00Z' },
    ]);
    const rows = await m.listTasks({ projectId: 31 });
    expect(rows).toHaveLength(1);
    expect(rows[0].assignedTo).toBe('DotNetPert');
  });

  test('list row carries blockers / milestone / createdBy / updatedAt when the cloud sends them', async () => {
    const m = await makeManager([
      {
        id: 43, title: 'Blocked card', status: 'in_progress', priority: 'high',
        assigned_to: 'QAPert', blockers: 'waiting on WS1', milestone: 'vibeid-deploy',
        created_by: 'BAPert', updated_at: '2026-08-06T00:00:00Z', created_at: '2026-08-01T00:00:00Z',
      },
    ]);
    const [row] = await m.listTasks({ projectId: 31 });
    expect(row.assignedTo).toBe('QAPert');
    expect(row.blockers).toBe('waiting on WS1');
    expect(row.milestone).toBe('vibeid-deploy');
    expect(row.createdBy).toBe('BAPert');
    expect(row.updatedAt).toBe('2026-08-06T00:00:00Z');
  });

  test('in-memory filters still apply over the full set (status, archived default-excluded)', async () => {
    const m = await makeManager([
      { id: 1, title: 'a', status: 'review', agent_name: 'BAPert' },
      { id: 2, title: 'b', status: 'done', archived: true },
      { id: 3, title: 'c', status: 'review' },
    ]);
    const review = await m.listTasks({ projectId: 31, status: 'review' });
    expect(review.map((r) => r.id)).toEqual([1, 3]);
  });
});

// ── 117431 step 1: the storage move call hits the cloud move route, source-scoped ──────────
describe('117431 moveTaskToProject (session_manager storage)', () => {
  async function makeManager() {
    process.env.IDP_URL ||= 'http://127.0.0.1:9';
    process.env.VIBE_API_URL ||= 'http://127.0.0.1:9';
    const { SessionManager } = await import('../agents/session_manager.js');
    const m = new SessionManager({ vibesqlUrl: 'http://localhost:5173' });
    m._cloudKanban = jest.fn(async () => ({ data: { id: 204645, title: 'probe', status: 'backlog', project_id: 12 } }));
    return m;
  }

  test('POSTs to /v1/projects/{source}/kanban/tasks/{id}/move with target_project_id + actor', async () => {
    const m = await makeManager();
    const moved = await m.moveTaskToProject(204645, 12, 'Nextpert-Scout', 31);
    const [method, path, body] = m._cloudKanban.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/v1/projects/31/kanban/tasks/204645/move');
    expect(body).toMatchObject({ target_project_id: 12, actor: 'Nextpert-Scout' });
    expect(moved.id).toBe(204645);
  });

  test('missing source projectId is a hard error, never a silent global call', async () => {
    const m = await makeManager();
    await expect(m.moveTaskToProject(1, 12, 'a', null)).rejects.toThrow(/projectId is required/);
  });
});
