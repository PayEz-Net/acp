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
// they keep their guarded endpoints, so transitions/assignment-lock are unbypassable
// ⚠ THROUGH THIS PROXY ONLY. That clause used to read "unbypassable" full stop, and it
// was measured false on 2026-08-08: the .NET PATCH
// (PayEz.Vibe.Public.Api ProjectController.UpdateKanbanTask) does a project-access check
// and then passes Status and AssignedTo straight through ToWrite to the repository. It
// enforces no transition graph and no assignment lock, because neither exists on that
// side — they are defined here and nowhere else. Anything reaching the cloud endpoint
// directly can move a task backlog -> done in one call.
// Ruled 2026-08-08: the .NET API is to become authoritative for both. Until that lands,
// this file is the ONLY enforcement and it binds only callers who come through it.
//
// ⚠ THIS RULE EXISTS TWICE, IN TWO LANGUAGES. Fixing it here does NOT fix it for
// callers who reach the .NET path, and vice versa. The twin lives in PayEz-Core:
//     PayEz.Vibe.Public.Api/Controllers/V1/ProjectController.cs
//     PayEz.Infrastructure/Repositories/Vibe/KanbanRepository.cs
// PayEz-Core commit 7974a9773 ("persist `archived` + reject unknown fields") fixed the
// .NET side on 2026-08-05 and shipped as vibe-api:archive-persist-7974a9773. THIS array
// was not updated, so the defect stayed live on the Node path — five agents spent an
// evening rediscovering it as cards 189672 and 189807 while the fix sat deployed.
//
// This is 31-WO-H1 §T4 verbatim: "ONE shared validation library, consumed by every
// resource server — never per-service parsing (N implementations become N dialects)".
// Before editing this array, change the .NET twin in the same work, or record why not.
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

// 121194 residual (rides 117431): the list endpoint accepted limit/offset/page and IGNORED
// them — four paging contracts returned an identical full table. This is the single place
// paging is applied; it exists so the contract is real and unit-testable. `page` is NOT
// honoured — the API never documented it and two paging dialects is how we got here.
export function applyPaging(rows, { limit, offset } = {}) {
  const total = rows.length;
  let off = 0;
  let lim = null;
  if (offset !== undefined) {
    off = Number(offset);
    if (!Number.isInteger(off) || off < 0) throw invalid(`Invalid offset "${offset}". Must be a non-negative integer`);
  }
  if (limit !== undefined) {
    lim = Number(limit);
    if (!Number.isInteger(lim) || lim < 1) throw invalid(`Invalid limit "${limit}". Must be a positive integer`);
  }
  const page = lim == null ? rows.slice(off) : rows.slice(off, off + lim);
  return { rows: page, total, limit: lim, offset: off, hasMore: off + page.length < total };
}

// G1 — edit free-form fields. Rejects status/assignee (guarded elsewhere) and
// unknown fields (no silent drop).
export async function editTask(storage, id, updates, actor, projectId) {
  const task = await getTask(storage, id, projectId);
  if ('status' in updates) throw invalid('Cannot edit status via PATCH — use PUT /tasks/:id/status');
  if ('assignedTo' in updates || 'assignee' in updates) throw invalid('Cannot edit assignee via PATCH — use PUT /tasks/:id/assign');
  // 117431 step 1: project moves get a NAMED rejection pointing at the real route — never a
  // generic "not editable" and never silent acceptance.
  if ('projectId' in updates || 'project_id' in updates) throw invalid('Cannot edit projectId via PATCH — use PUT /tasks/:id/move');

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
  // #109 + #64(b) UNION: capture the prior assignee BEFORE the update so we can BOTH
  // (a) PERSIST a true "reassigned" vs first-"assigned" activity (recordActivity — wo1
  // live behavior, the activity trail) AND (b) EXPOSE previousAssignee on the return so
  // the route's #109 SSE localEventBus emit lights the renderer's
  // `assigned && from -> reassigned` branch. detail stays the NEW assignee name (the
  // panel renders it); to mirrors detail. archive/unarchive are handled by the single
  // parametrized archiveTask(storage,id,archived,...) below (#64 G5 supersedes #152's
  // separate archiveTask/unarchiveTask; unarchive = archiveTask(...,false)).
  const previousAssignee = task.assignedTo ?? null;
  const updates = { assignedTo: agentName, updatedAt: new Date().toISOString() };
  await storage.updateTask(id, updates, projectId);
  await recordActivity(storage, id, actor || agentName, 'assigned', {
    from: previousAssignee, to: agentName, detail: agentName, projectId,
  });
  return { ...task, ...updates, previousAssignee };
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
  await getTask(storage, id, projectId); // 404 if missing
  // #152: return the RE-READ persisted row from updateTask (RETURNING *), never an optimistic
  // {...task, archived} merge. updateTask throws on a query error and returns null when no row
  // matched (id+project_id). A null here means the archive did NOT take effect — surface it as a
  // hard failure rather than fake-green {archived:true}. The response must reflect real DB state.
  const updated = await storage.updateTask(
    id, { archived: !!archived, updatedAt: new Date().toISOString() }, projectId);
  if (!updated) {
    const err = new Error(`Archive did not persist for task ${id} (no row updated)`);
    err.code = 'ARCHIVE_NOT_PERSISTED';
    throw err;
  }
  await recordActivity(storage, id, actor, archived ? 'archived' : 'unarchived', { projectId });
  return updated;
}

// 117431 build-order step 1 — move a card BETWEEN projects, preserving the task id. Today a
// misfiled card is unrecoverable (PATCH rejects projectId, no move route). The authoritative
// write + guard on BOTH projects + the 'moved' activity entry live in the .NET twin
// (PayEz.Vibe.Public.Api ProjectController.MoveKanbanTask) — this layer validates and forwards,
// and deliberately does NOT recordActivity itself so the trail isn't double-written.
export async function moveTaskToProject(storage, id, targetProjectId, actor, projectId) {
  await getTask(storage, id, projectId); // 404 if missing from the active project
  const target = Number(targetProjectId);
  if (!Number.isInteger(target) || target <= 0) throw invalid('target_project_id is required (positive integer)');
  if (target === Number(projectId)) throw invalid(`Task ${id} is already on project ${projectId}`);
  if (typeof storage.moveTaskToProject !== 'function') {
    const err = new Error('storage does not support moveTaskToProject (cloud build predates the move endpoint)');
    err.code = 'MOVE_UNSUPPORTED';
    throw err;
  }
  const moved = await storage.moveTaskToProject(id, target, actor || null, projectId);
  if (!moved) {
    const err = new Error(`Move did not persist for task ${id} (no row updated)`);
    err.code = 'MOVE_NOT_PERSISTED';
    throw err;
  }
  return moved;
}
