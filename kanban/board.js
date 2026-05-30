// #64 kanban mutation surface (Aurum kanban-mutations-spec v1.1, RATIFIED).
// Additive over the existing create/read/status/assign/review; reuses
// storage.updateTask + the real vibe.kanban_tasks table. No new fallbacks —
// validate + fail loud (INVALID_REQUEST / TASK_NOT_FOUND).

const VALID_STATUSES = ['backlog', 'in_progress', 'review', 'done', 'blocked']; // G2: `todo` RETIRED (v1.1)
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];

// G2 ratified five-state graph. Agents move only along these edges; the human
// can `force` any transition (human-auth gated at the route, audited as forced).
const TRANSITIONS = {
  backlog: ['in_progress'],
  in_progress: ['review', 'blocked', 'backlog'],
  review: ['done', 'in_progress', 'blocked'],
  blocked: ['in_progress', 'backlog'],
  done: ['in_progress', 'review'], // reopen (clears completedAt)
};

// G1: PATCH touches FREE-FORM fields only. status + assignedTo are excluded —
// they keep their guarded endpoints so transitions/assignment-lock are unbypassable.
const EDITABLE_FIELDS = ['title', 'description', 'priority', 'milestone', 'blockers', 'specPath', 'filesChanged'];

export { VALID_STATUSES, VALID_PRIORITIES, TRANSITIONS, EDITABLE_FIELDS };

function invalid(message) {
  const err = new Error(message);
  err.code = 'INVALID_REQUEST';
  return err;
}

// G4: best-effort audit append — NEVER fails the mutation it records.
async function recordActivity(storage, taskId, actor, action, { from, to, detail, projectId } = {}) {
  try {
    if (storage.appendKanbanActivity) {
      await storage.appendKanbanActivity({
        taskId, actor: actor || null, action,
        fromStatus: from ?? null, toStatus: to ?? null, detail: detail ?? null,
        projectId: projectId ?? null,
      });
    }
  } catch (err) {
    // Best-effort = never BLOCK the mutation, but never SILENT either (Aurum 2036):
    // a dropped audit on a real mutation is an anomaly — log it LOUD so it's
    // diagnosable, not a silent hole.
    console.error(`[kanban] AUDIT append FAILED for task ${taskId} action '${action}': ${err?.message || err}`);
  }
}

export { recordActivity };

export async function createTask(storage, task, projectId) {
  if (!task.title) throw invalid('Task title is required');
  if (task.status && !VALID_STATUSES.includes(task.status)) {
    throw invalid(`Invalid status "${task.status}". Valid: ${VALID_STATUSES.join(', ')}`);
  }
  if (task.priority && !VALID_PRIORITIES.includes(task.priority)) {
    throw invalid(`Invalid priority "${task.priority}". Valid: ${VALID_PRIORITIES.join(', ')}`);
  }
  const id = await storage.createTask({
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
  }, projectId);
  await recordActivity(storage, id, task.createdBy, 'created', { to: task.status || 'backlog', projectId });
  return id;
}

export async function getTask(storage, id, projectId) {
  const task = await storage.getTask(id, projectId);
  if (!task) {
    const err = new Error(`Task ${id} not found`);
    err.code = 'TASK_NOT_FOUND';
    throw err;
  }
  return task;
}

export async function listTasks(storage, filter = {}, projectId) {
  if (projectId != null) filter.projectId = projectId;
  return storage.listTasks(filter); // storage excludes archived unless filter.includeArchived
}

// G1 — edit free-form fields. Rejects status/assignee (guarded elsewhere) and
// unknown fields (no silent drop).
export async function editTask(storage, id, updates, actor, projectId) {
  const task = await getTask(storage, id, projectId);
  if ('status' in updates) throw invalid('Cannot edit status via PATCH — use PUT /tasks/:id/status');
  if ('assignedTo' in updates || 'assignee' in updates) throw invalid('Cannot edit assignee via PATCH — use PUT /tasks/:id/assign');

  const clean = {};
  for (const [k, v] of Object.entries(updates)) {
    if (!EDITABLE_FIELDS.includes(k)) {
      throw invalid(`Field "${k}" is not editable. Allowed: ${EDITABLE_FIELDS.join(', ')}`);
    }
    clean[k] = v;
  }
  if (Object.keys(clean).length === 0) throw invalid('No editable fields provided');
  if (clean.priority != null && !VALID_PRIORITIES.includes(clean.priority)) {
    throw invalid(`Invalid priority "${clean.priority}". Valid: ${VALID_PRIORITIES.join(', ')}`);
  }
  clean.updatedAt = new Date().toISOString();
  await storage.updateTask(id, clean, projectId);
  await recordActivity(storage, id, actor, 'edited', {
    detail: Object.keys(clean).filter((k) => k !== 'updatedAt').join(','),
    projectId,
  });
  return { ...task, ...clean };
}

// G2 — move status. `force` (human-auth gated at route) allows any valid status
// off the legal graph; audited as a forced transition. Reopen clears completedAt.
/** @param {{ force?: boolean, actor?: string }} [opts] */
export async function moveTask(storage, id, newStatus, opts = {}, projectId) {
  const { force = false, actor } = opts;
  const task = await getTask(storage, id, projectId);
  if (!VALID_STATUSES.includes(newStatus)) {
    throw invalid(`Invalid status "${newStatus}". Valid: ${VALID_STATUSES.join(', ')}`);
  }
  const allowed = TRANSITIONS[task.status] || [];
  const isLegal = allowed.includes(newStatus);
  if (!isLegal && !force) {
    throw invalid(`Cannot move task from "${task.status}" to "${newStatus}". Allowed: ${allowed.join(', ') || 'none'}`);
  }
  const updates = { status: newStatus, updatedAt: new Date().toISOString() };
  if (newStatus === 'done') updates.completedAt = new Date().toISOString();
  else if (task.status === 'done') updates.completedAt = null; // reopen
  await storage.updateTask(id, updates, projectId);
  await recordActivity(storage, id, actor, force && !isLegal ? 'status_forced' : 'status_moved', {
    from: task.status, to: newStatus, projectId,
  });
  return { ...task, ...updates };
}

/** @param {{ requireUnassigned?: boolean, actor?: string }} [opts] */
export async function assignTask(storage, id, agentName, opts = {}, projectId) {
  const { requireUnassigned = false, actor } = opts;
  const task = await getTask(storage, id, projectId);
  if (requireUnassigned && task.assignedTo) {
    const err = new Error(`Task ${id} is already assigned to ${task.assignedTo}`);
    err.code = 'CONFLICT';
    throw err;
  }
  const updates = { assignedTo: agentName, updatedAt: new Date().toISOString() };
  await storage.updateTask(id, updates, projectId);
  await recordActivity(storage, id, actor || agentName, 'assigned', { detail: agentName, projectId });
  return { ...task, ...updates };
}

// G3 — comments thread.
export async function addComment(storage, id, { body_md, author }, projectId) {
  await getTask(storage, id, projectId); // 404 if missing
  if (!body_md || !String(body_md).trim()) throw invalid('Comment body (body_md) is required');
  const comment = await storage.addKanbanComment({ taskId: id, author: author || null, bodyMd: String(body_md).trim(), projectId });
  await recordActivity(storage, id, author, 'commented', { projectId });
  return comment;
}

export async function listComments(storage, id, projectId) {
  await getTask(storage, id, projectId);
  return storage.listKanbanComments(id, projectId);
}

// G4 — activity trail.
export async function listActivity(storage, id, projectId) {
  await getTask(storage, id, projectId);
  return storage.listKanbanActivity(id, projectId);
}

// G5 — soft-archive (not hard-delete; preserves trail).
export async function archiveTask(storage, id, archived, actor, projectId) {
  const task = await getTask(storage, id, projectId);
  await storage.updateTask(id, { archived: !!archived, updatedAt: new Date().toISOString() }, projectId);
  await recordActivity(storage, id, actor, archived ? 'archived' : 'unarchived', { projectId });
  return { ...task, archived: !!archived };
}
