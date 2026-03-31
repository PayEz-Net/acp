const VALID_STATUSES = ['backlog', 'in_progress', 'review', 'done', 'blocked'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];

const TRANSITIONS = {
  backlog: ['in_progress'],
  in_progress: ['review', 'blocked'],
  review: ['done', 'in_progress'],
  blocked: ['in_progress'],
  done: [],
};

export { VALID_STATUSES, VALID_PRIORITIES, TRANSITIONS };

export async function createTask(storage, task) {
  if (!task.title) {
    const err = new Error('Task title is required');
    err.code = 'INVALID_REQUEST';
    throw err;
  }
  return storage.createTask({
    title: task.title,
    description: task.description || null,
    status: task.status || 'backlog',
    priority: task.priority || 'medium',
    assignedTo: task.assignedTo || null,
    createdBy: task.createdBy || null,
    specPath: task.specPath || null,
    milestone: task.milestone || null,
    filesChanged: task.filesChanged || [],
    blockers: task.blockers || null,
  });
}

export async function getTask(storage, id) {
  const task = await storage.getTask(id);
  if (!task) {
    const err = new Error(`Task ${id} not found`);
    err.code = 'TASK_NOT_FOUND';
    throw err;
  }
  return task;
}

export async function listTasks(storage, filter = {}) {
  return storage.listTasks(filter);
}

export async function moveTask(storage, id, newStatus) {
  const task = await getTask(storage, id);
  const allowed = TRANSITIONS[task.status] || [];
  if (!allowed.includes(newStatus)) {
    const err = new Error(`Cannot move task from "${task.status}" to "${newStatus}". Allowed: ${allowed.join(', ') || 'none'}`);
    err.code = 'INVALID_REQUEST';
    throw err;
  }
  const updates = { status: newStatus, updatedAt: new Date().toISOString() };
  if (newStatus === 'done') updates.completedAt = new Date().toISOString();
  await storage.updateTask(id, updates);
  return { ...task, ...updates };
}

export async function assignTask(storage, id, agentName, { requireUnassigned = false } = {}) {
  const task = await getTask(storage, id);
  // F-3: Optimistic lock for self-assignment race condition
  if (requireUnassigned && task.assignedTo) {
    const err = new Error(`Task ${id} is already assigned to ${task.assignedTo}`);
    err.code = 'CONFLICT';
    throw err;
  }
  const updates = { assignedTo: agentName, updatedAt: new Date().toISOString() };
  await storage.updateTask(id, updates);
  return { ...task, ...updates };
}
