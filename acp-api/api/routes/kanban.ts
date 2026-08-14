import { Router, type Request, type Response } from 'express';
import { success } from '../response.js';
import { createTask, getTask, listTasks, moveTask, assignTask, editTask, addComment, listComments, listActivity, archiveTask, moveTaskToProject, applyPaging } from '../../kanban/board.js';
import { reviewTask, autoMailOnStatusChange } from '../../kanban/review.js';
import { makeApiMailSender } from '../../collaboration/mail.js';
import type { LocalEventBus } from '../sse/localEventBus.js';

export default function kanbanRoutes(storage: any, localEventBus?: LocalEventBus, opts: { pathScoped?: boolean } = {}): Router {
  // mergeParams: when mounted path-scoped at /v1/projects/:projectId/kanban, the parent's
  // :projectId must be visible to these routes.
  const router = Router({ mergeParams: true });
  const pathScoped = opts.pathScoped === true;

  // 117431 step 2: a project is an INSTANTIATION, not a filter. In path-scoped mode the
  // project comes from the path (the addressed shape); otherwise from the active project
  // (legacy ambient scope). A garbage path id is a 400, never a silent fallback to ambient.
  const resolveProjectId = async (req: Request): Promise<number> => {
    if (!pathScoped) return storage.getActiveProjectId();
    const raw = (req.params as any).projectId;
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) {
      const err = new Error(`Invalid project id "${raw}" in path`) as Error & { code?: string };
      err.code = 'INVALID_REQUEST';
      throw err;
    }
    return pid;
  };

  // 117431 step 2 PREFIX GATE (RULING A, BAPert 2026-08-11, mail thread 1ef8de65732e4a12):
  // a bearer (human) caller's access answer comes from the CLOUD — the sidecar forwards its
  // session JWT to the existing project read; 200 = allow, 404/403 = deny. Denial is 404 on
  // reads (existence-hiding, the cloud's own double-NotFound semantic) and 403 on writes.
  // X-ACP-Agent callers BYPASS exactly as today (no regression): the header is self-asserted
  // and keying authz on it rebuilds 196241 one layer down — per-project agent scoping is
  // card 210601 (Jon-altitude). A resolve FAILURE throws (503 upstream) — never fail open,
  // never fake-deny.
  if (pathScoped) {
    router.use(async (req: Request, res: Response, next) => {
      try {
        if ((req as any).authMethod !== 'bearer') return next();
        const raw = (req.params as any).projectId;
        const pid = Number(raw);
        if (!Number.isInteger(pid) || pid <= 0) {
          const err = new Error(`Invalid project id "${raw}" in path`) as Error & { code?: string };
          err.code = 'INVALID_REQUEST';
          throw err;
        }
        if (typeof storage.canSeeProject !== 'function') {
          const err = new Error('storage does not support canSeeProject (cloud build predates the access answer)') as Error & { code?: string };
          err.code = 'STORAGE_ERROR';
          throw err;
        }
        if (await storage.canSeeProject(pid)) return next();
        const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
        res.status(isWrite ? 403 : 404).json({
          success: false,
          message: isWrite ? 'No write access to this project' : 'Project not found',
          error: { code: isWrite ? 'FORBIDDEN' : 'NOT_FOUND', message: isWrite ? `No write access to project ${pid}` : `Project ${pid} not found` },
        });
      } catch (err) {
        next(err);
      }
    });
  }

  // #64 GAP 4: transition notifications go through the LIVE mail API (/v1/mail/send),
  // not the orphaned storage.createMessage path. See collaboration/mail.js.
  const notifyMail = makeApiMailSender();

  router.post('/tasks', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_create';
      // Archived project guard
      const activeProjectId = await resolveProjectId(req);
      if (activeProjectId) {
        const project = await storage.getProject(activeProjectId);
        if (project?.status === 'archived') {
          res.status(403).json({ success: false, message: 'Project is archived', error: { code: 'PROJECT_ARCHIVED' } });
          return;
        }
      }
      // AC-6: set createdBy from auth context if not explicitly provided
      if (!req.body.createdBy && (req as any).agentName) {
        req.body.createdBy = (req as any).agentName;
      }
      // 117431 step 3: project_id is accepted NOWHERE on this route. It was silently ignored
      // on create for months (cards landed on the ACTIVE project while the 201 said success —
      // four cards misled a human). Reject loudly and name the two real shapes.
      if (req.body.project_id !== undefined || req.body.projectId !== undefined) {
        const err = new Error('project_id is not accepted here — cards are created on the ACTIVE project (switch it with POST /v1/projects/current), or use POST /v1/projects/{id}/kanban/tasks') as Error & { code?: string };
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const projectId = await resolveProjectId(req);
      const id = await createTask(storage, req.body, projectId);
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      localEventBus?.emit({
        event: 'kanban-update',
        data: { action: 'created', task_id: id },
      });
      res.json(success({ id }, 'kanban_create', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_list';
      const filter: any = {};
      if (req.query.status) filter.status = (req.query.status as string).split(',');
      if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;
      if (req.query.milestone) filter.milestone = req.query.milestone;
      if (req.query.priority) filter.priority = req.query.priority;
      // #152: archived tasks are excluded by default. ?archived=true -> archived view only;
      // ?includeArchived=true -> both active and archived.
      if (req.query.archived === 'true') filter.archived = true;
      if (req.query.includeArchived === 'true') filter.includeArchived = true;
      // 117431 step 3: ?project_id was accepted and IGNORED (the list always served the
      // active project, and the 200 looked like an answer). Reject it permanently — a
      // project is an instantiation, not a filter; the addressed shape is the path.
      if (req.query.project_id !== undefined || req.query.projectId !== undefined) {
        const err = new Error('project_id is not accepted here — the board is scoped to the ACTIVE project; per-project boards live at /v1/projects/{id}/kanban/tasks') as Error & { code?: string };
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      // #64: project-scoped board.
      const projectId = await resolveProjectId(req);
      const all = await listTasks(storage, filter, projectId);
      // 121194: limit/offset were accepted and ignored — every paging contract got the full
      // table. applyPaging makes the contract real (and 400s on garbage). `page` never
      // existed as a contract; one paging dialect only.
      const paged = applyPaging(all, { limit: req.query.limit as string | undefined, offset: req.query.offset as string | undefined });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(paged.rows, 'kanban_list', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
        pagination: { total: paged.total, limit: paged.limit, offset: paged.offset, has_more: paged.hasMore },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_get';
      const projectId = await resolveProjectId(req);
      const task = await getTask(storage, parseInt(req.params.id as string, 10), projectId);
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_get', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/tasks/:id/status', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_status';
      const { status, force } = req.body || {};
      if (!status) {
        const err = new Error('Status is required') as Error & { code?: string };
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      // #64 G2: `force` (off-graph move) is HUMAN-ONLY. The desktop authenticates
      // with the ACP_LOCAL_SECRET Bearer (authMethod='bearer'); agents (X-ACP-Agent)
      // are DENIED — an agent token + force is privilege-escalation (spec §4.2).
      if (force === true && (req as any).authMethod !== 'bearer') {
        res.status(403).json({ success: false, message: 'force-move is human-only (agents must follow legal transitions)', error: { code: 'FORBIDDEN' } });
        return;
      }
      const actor = (req as any).agentName;
      const projectId = await resolveProjectId(req);
      const task = await moveTask(storage, parseInt(req.params.id as string, 10), status, { force: force === true, actor }, projectId);
      // #64 GAP 4: notify via the LIVE mail API (notifyMail), not the orphaned
      // storage.createMessage path that silently stranded ->review/->done cards
      // (#59/#61/#63/#65). The notify must still NEVER fail the transition, but a
      // failure on a real transition is now an anomaly — log it LOUDLY (error), don't
      // normalize it as "expected/skipped".
      try {
        await autoMailOnStatusChange(storage, notifyMail, task, status, actor);
      } catch (mailErr: any) {
        console.error(`[kanban] status-change notification FAILED for task ${req.params.id} -> ${status} (transition still applied): ${mailErr?.message || mailErr}`);
      }
      localEventBus?.emit({
        event: 'kanban-update',
        data: { action: 'status_changed', task_id: req.params.id, status },
      });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_status', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/tasks/:id/assign', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_assign';
      const { agent } = req.body || {};
      if (!agent) {
        const err = new Error('Agent is required') as Error & { code?: string };
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const requireUnassigned = req.body.requireUnassigned === true;
      const projectId = await resolveProjectId(req);
      const task = await assignTask(storage, parseInt(req.params.id as string, 10), agent, { requireUnassigned, actor: (req as any).agentName }, projectId);
      // #109 + #64: board.assignTask PERSISTS the assigned/reassigned distinction via
      // recordActivity; here we ALSO emit the live SSE re-light. from=<prevAssignee> only on a
      // TRUE reassignment (task already had a different owner) so the renderer re-lights
      // 'reassigned' on action==='assigned' && from. First-assign or re-assign to the same
      // agent stay a plain 'assigned'.
      const reassigned = task.previousAssignee && task.previousAssignee !== agent;
      localEventBus?.emit({
        event: 'kanban-update',
        data: reassigned
          ? { action: 'assigned', task_id: req.params.id, agent, from: task.previousAssignee, to: agent }
          : { action: 'assigned', task_id: req.params.id, agent },
      });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_assign', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err: any) {
      if (err.code === 'CONFLICT') {
        res.status(409).json({ success: false, message: err.message, error: { code: 'CONFLICT' } });
        return;
      }
      next(err);
    }
  });

  // 117431 build-order step 1: cross-project MOVE. Body { project_id }. The authoritative
  // write + both-project guard + 'moved' activity live in the .NET twin
  // (ProjectController.MoveKanbanTask); this route validates, forwards, and re-lights the board.
  router.put('/tasks/:id/move', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_move_project';
      const target = req.body?.project_id ?? req.body?.target_project_id;
      if (target == null) {
        const err = new Error('project_id (target project) is required') as Error & { code?: string };
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const projectId = await resolveProjectId(req);
      const task = await moveTaskToProject(storage, parseInt(req.params.id as string, 10), target, (req as any).agentName, projectId);
      localEventBus?.emit({
        event: 'kanban-update',
        data: { action: 'moved', task_id: req.params.id, from: projectId, to: Number(target) },
      });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_move_project', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  // RECONCILE NOTE (#152 vs #64 G5): #152 added PUT /archive + PUT /unarchive using a 2-arg
  // archiveTask + a separate unarchiveTask. The running build (#64 G5, wo1) instead exposes
  // POST /archive + POST /unarchive over the parametrized archiveTask(storage,id,archived,actor,
  // projectId) with activity-recording + project scope (see below, ~line 230). Same capability,
  // one canonical surface — the #152 PUT pair is dropped to match the live build and the unified
  // board.js signature (a 2-arg archiveTask would now mean archived=undefined=false). The
  // default-board-excludes-archived intent of #152 is preserved by the NULL-safe filter in
  // session_manager.listTasks.

  router.put('/tasks/:id/review', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_review';
      const { action, notes, reviewer } = req.body || {};
      if (!action) {
        const err = new Error('Review action is required (approve, reject, comment)') as Error & { code?: string };
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const projectId = await resolveProjectId(req);
      const task = await reviewTask(storage, notifyMail, parseInt(req.params.id as string, 10), action, { notes, reviewer }, projectId);
      localEventBus?.emit({
        event: 'kanban-update',
        data: { action: 'reviewed', task_id: req.params.id, review_action: action },
      });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_review', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  // #64 G1: PATCH /tasks/:id — edit FREE-FORM fields (title/description/priority/
  // milestone/blockers/specPath/filesChanged). status/assignee rejected (guarded).
  router.patch('/tasks/:id', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_edit';
      const projectId = await resolveProjectId(req);
      const task = await editTask(storage, parseInt(req.params.id as string, 10), req.body || {}, (req as any).agentName, projectId);
      localEventBus?.emit({ event: 'kanban-update', data: { action: 'edited', task_id: req.params.id } });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_edit', (req as any).requestId, { performance: { response_time_ms: elapsed } }));
    } catch (err) { next(err); }
  });

  // #64 G3: comment thread
  router.post('/tasks/:id/comments', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_comment_add';
      const projectId = await resolveProjectId(req);
      const comment = await addComment(storage, parseInt(req.params.id as string, 10),
        { body_md: req.body?.body_md, author: req.body?.author || (req as any).agentName }, projectId);
      localEventBus?.emit({ event: 'kanban-update', data: { action: 'commented', task_id: req.params.id } });
      res.json(success(comment, 'kanban_comment_add', (req as any).requestId));
    } catch (err) { next(err); }
  });
  router.get('/tasks/:id/comments', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_comment_list';
      const projectId = await resolveProjectId(req);
      const comments = await listComments(storage, parseInt(req.params.id as string, 10), projectId);
      res.json(success(comments, 'kanban_comment_list', (req as any).requestId));
    } catch (err) { next(err); }
  });

  // #64 G4: activity / audit trail
  router.get('/tasks/:id/activity', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_activity';
      const projectId = await resolveProjectId(req);
      const activity = await listActivity(storage, parseInt(req.params.id as string, 10), projectId);
      res.json(success(activity, 'kanban_activity', (req as any).requestId));
    } catch (err) { next(err); }
  });

  // #64 G5: soft-archive / unarchive
  router.post('/tasks/:id/archive', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_archive';
      const projectId = await resolveProjectId(req);
      const task = await archiveTask(storage, parseInt(req.params.id as string, 10), true, (req as any).agentName, projectId);
      localEventBus?.emit({ event: 'kanban-update', data: { action: 'archived', task_id: req.params.id } });
      res.json(success(task, 'kanban_archive', (req as any).requestId));
    } catch (err) { next(err); }
  });
  router.post('/tasks/:id/unarchive', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_unarchive';
      const projectId = await resolveProjectId(req);
      const task = await archiveTask(storage, parseInt(req.params.id as string, 10), false, (req as any).agentName, projectId);
      localEventBus?.emit({ event: 'kanban-update', data: { action: 'unarchived', task_id: req.params.id } });
      res.json(success(task, 'kanban_unarchive', (req as any).requestId));
    } catch (err) { next(err); }
  });

  return router;
}
