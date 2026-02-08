import { Router } from 'express';
import { success } from '../response.js';
import { Supervisor } from '../../autonomy/supervisor.js';

export default function autonomyRoutes(storage, cfg = {}) {
  const router = Router();
  const supervisor = new Supervisor(storage, cfg);

  router.post('/start', async (req, res, next) => {
    try {
      req.operationCode = 'autonomy_start';
      const state = await supervisor.start(req.body || {});
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(state, 'autonomy_start', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/stop', async (req, res, next) => {
    try {
      req.operationCode = 'autonomy_stop';
      const { reason } = req.body || {};
      const state = await supervisor.stop(reason || 'manual');
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(state, 'autonomy_stop', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/status', async (req, res, next) => {
    try {
      req.operationCode = 'autonomy_status';
      const state = await supervisor.getState();
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(state || { enabled: false }, 'autonomy_status', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/standup', async (req, res, next) => {
    try {
      req.operationCode = 'autonomy_standup';
      const entries = await supervisor.getStandup();
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(entries || [], 'autonomy_standup', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/standup', async (req, res, next) => {
    try {
      req.operationCode = 'autonomy_standup_add';
      const id = await supervisor.addStandupEntry(req.body);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ id }, 'autonomy_standup_add', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
