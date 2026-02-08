import { jest } from '@jest/globals';
import { createTask, getTask, listTasks, moveTask, assignTask, TRANSITIONS } from '../kanban/board.js';

function createMockStorage() {
  return {
    createTask: jest.fn(async () => 1),
    getTask: jest.fn(async () => null),
    listTasks: jest.fn(async () => []),
    updateTask: jest.fn(async () => {}),
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
    expect(storage.updateTask).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'in_progress' }));
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

  test('rejects move from done', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'done' });
    await expect(moveTask(storage, 1, 'in_progress')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('assignTask', () => {
  test('assigns agent to task', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    const result = await assignTask(storage, 1, 'DotNetPert');
    expect(result.assignedTo).toBe('DotNetPert');
    expect(storage.updateTask).toHaveBeenCalledWith(1, expect.objectContaining({ assignedTo: 'DotNetPert' }));
  });
});

describe('TRANSITIONS', () => {
  test('defines valid state machine', () => {
    expect(TRANSITIONS.backlog).toContain('in_progress');
    expect(TRANSITIONS.in_progress).toContain('review');
    expect(TRANSITIONS.in_progress).toContain('blocked');
    expect(TRANSITIONS.review).toContain('done');
    expect(TRANSITIONS.review).toContain('in_progress');
    expect(TRANSITIONS.blocked).toContain('in_progress');
    expect(TRANSITIONS.done).toEqual([]);
  });
});
