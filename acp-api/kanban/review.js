import { getTask, recordActivity } from './board.js';

export async function reviewTask(storage, mailSender, id, action, opts = {}, projectId) {
  const task = await getTask(storage, id, projectId);

  if (task.status !== 'review') {
    const err = new Error(`Task ${id} is not in review (current: ${task.status})`);
    err.code = 'INVALID_REQUEST';
    throw err;
  }

  const now = new Date().toISOString();
  const reviewer = opts.reviewer || 'QAPert';

  if (action === 'approve') {
    const updates = { status: 'done', completedAt: now, updatedAt: now, reviewedBy: reviewer, reviewNotes: opts.notes || null };
    await storage.updateTask(id, updates, projectId);
    await recordActivity(storage, id, reviewer, 'reviewed', { from: task.status, to: 'done', detail: 'approved', projectId });
    if (mailSender && task.assignedTo) {
      await mailSender(storage, {
        from: reviewer,
        to: task.assignedTo,
        subject: `APPROVED: ${task.title}`,
        body: `Task "${task.title}" approved.${opts.notes ? ` Notes: ${opts.notes}` : ''}`,
        priority: 'normal',
      });
    }
    if (mailSender && task.createdBy && task.createdBy !== task.assignedTo) {
      await mailSender(storage, {
        from: reviewer,
        to: task.createdBy,
        subject: `DONE: ${task.title}`,
        body: `Task "${task.title}" completed and approved by ${reviewer}.`,
        priority: 'normal',
      });
    }
    return { ...task, ...updates };
  }

  if (action === 'reject') {
    const updates = { status: 'in_progress', updatedAt: now, reviewedBy: reviewer, reviewNotes: opts.notes || 'Rejected — needs rework' };
    await storage.updateTask(id, updates, projectId);
    await recordActivity(storage, id, reviewer, 'reviewed', { from: task.status, to: 'in_progress', detail: 'rejected', projectId });
    if (mailSender && task.assignedTo) {
      await mailSender(storage, {
        from: reviewer,
        to: task.assignedTo,
        subject: `REJECTED: ${task.title}`,
        body: `Task "${task.title}" needs rework. Notes: ${opts.notes || 'See review notes.'}`,
        priority: 'high',
      });
    }
    return { ...task, ...updates };
  }

  if (action === 'comment') {
    const updates = { updatedAt: now, reviewedBy: reviewer, reviewNotes: opts.notes || '' };
    await storage.updateTask(id, updates, projectId);
    await recordActivity(storage, id, reviewer, 'reviewed', { detail: 'review-comment', projectId });
    return { ...task, ...updates };
  }

  const err = new Error(`Invalid review action "${action}". Must be: approve, reject, comment`);
  err.code = 'INVALID_REQUEST';
  throw err;
}

/**
 * `system` was never the notifier's identity - it was the FALLBACK in
 * `task.assignedTo || 'system'`, firing precisely when a card had no assignee, so
 * every move of an unassigned card 401'd: "Agent 'system' is not registered". The
 * transition applied and the assignee was never told.
 *
 * The actor is the honest sender - the agent who moved the card is a real roster
 * identity - and it was already in scope at the call site, used two lines away for
 * the activity record. A `system` fallback remains for actorless callers (Bearer
 * auth carries no agent name); those still 401 and still log loudly.
 */
export async function autoMailOnStatusChange(storage, mailSender, task, newStatus, actor) {
  if (!mailSender) return;
  const now = new Date().toISOString();

  if (newStatus === 'review') {
    await mailSender(storage, {
      from: actor || task.assignedTo || 'system',
      to: 'QAPert',
      subject: `REVIEW: ${task.title}`,
      body: `Task "${task.title}" ready for review.${task.specPath ? ` Spec: ${task.specPath}` : ''}`,
      priority: 'high',
      createdAt: now,
    });
  }

  if (newStatus === 'blocked') {
    await mailSender(storage, {
      from: actor || task.assignedTo || 'system',
      to: task.createdBy || 'BAPert',
      subject: `BLOCKED: ${task.title}`,
      body: `Task "${task.title}" is blocked.${task.blockers ? ` Reason: ${task.blockers}` : ''}`,
      priority: 'urgent',
      createdAt: now,
    });
  }

  if (newStatus === 'done') {
    await mailSender(storage, {
      from: actor || task.assignedTo || 'system',
      to: task.createdBy || 'BAPert',
      subject: `DONE: ${task.title}`,
      body: `Task "${task.title}" is complete.`,
      priority: 'normal',
      createdAt: now,
    });
  }
}
