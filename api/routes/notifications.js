import { Router } from 'express';
import { error } from '../response.js';

export default function notificationRoutes(storage) {
  const router = Router();

  // POST /v1/notifications
  router.post('/', async (req, res, next) => {
    try {
      req.operationCode = 'notifications_create';
      const { fromAgent, body } = req.body || {};
      if (!fromAgent || !body) {
        return res.status(400).json(
          error('INVALID_REQUEST', 'fromAgent and body are required', 'notifications_create', req.requestId)
        );
      }
      // HONEST-FAIL (WO 8201 Phase 1): this route is not wired to real
      // persistence (storage.createMessage was dropped — it would throw and
      // never persist). No renderer consumes POST /v1/notifications (UI
      // notifications are a client-side store). Return a loud, real error
      // instead of a fake created:true. Phase 2 WIRE = proxy to POST /v1/mail/send.
      return res.status(501).json(
        error(
          'NOTIFICATIONS_NOT_WIRED',
          'POST /v1/notifications is not implemented — agent messaging goes through POST /v1/mail/send (WO 8201; Phase 2 will proxy this route there).',
          'notifications_create',
          req.requestId,
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
