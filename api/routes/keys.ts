import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { config, type Config } from '../../config.js';
import { looksLikeKey, normalizeKey, hashKey, keyPrefix } from '../keys/keyCodec.js';
import { findKeyByHash, redeemKey } from '../keys/storage.js';
import { requireAdmin, isValidUuid } from '../keys/adminAuth.js';
import { RateLimiter } from '../keys/rateLimit.js';

const rateLimiter = new RateLimiter();

export default function keyRoutes(cfg: Config = config): Router {
  const router = Router();

  // POST /v1/keys/validate — public (added to PUBLIC_PATHS in localAuth.ts)
  router.post('/validate', async (req: Request, res: Response) => {
    try {
      const requestId = (req as any).requestId;
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

      if (!rateLimiter.check(clientIp)) {
        res.status(429).json(error('RATE_LIMITED', 'Too many validation attempts', 'keys_validate', requestId));
        return;
      }

      const { key } = req.body || {};

      if (!key || typeof key !== 'string') {
        res.status(400).json(error('VALIDATION_ERROR', 'key is required', 'keys_validate', requestId));
        return;
      }

      if (!looksLikeKey(key)) {
        res.status(400).json(error('VALIDATION_ERROR', 'key format invalid', 'keys_validate', requestId));
        return;
      }

      if (!cfg.licenseKeyPepper) {
        res.status(500).json(error('INTERNAL_ERROR', 'License key pepper not configured', 'keys_validate', requestId));
        return;
      }

      const normalized = normalizeKey(key);
      const keyHash = hashKey(normalized, cfg.licenseKeyPepper);
      const row = await findKeyByHash(keyHash);

      if (!row) {
        res.status(200).json(success({ valid: false, error: 'invalid' }, 'keys_validate', requestId));
        return;
      }

      const now = new Date();
      const expiresAt = new Date(row.expires_at);
      if (expiresAt < now) {
        res.status(200).json(success({ valid: false, error: 'expired', expiresAt: row.expires_at }, 'keys_validate', requestId));
        return;
      }

      if (row.status === 'revoked') {
        res.status(200).json(success({ valid: false, error: 'revoked' }, 'keys_validate', requestId));
        return;
      }

      // First validation: flip active → redeemed
      if (row.status === 'active') {
        const redeemed = await redeemKey(row.id);
        if (!redeemed) {
          // Race: another request flipped it between read and write.
          // Treat as already-redeemed (refresh path).
        }
      }

      // Boutique cache contract: client stores {key, lastValidated, expiresAt}
      res.status(200).json(success({
        valid: true,
        keyId: row.id,
        tier: row.tier,
        expiresAt: row.expires_at,
      }, 'keys_validate', requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'keys_validate', (req as any).requestId));
    }
  });

  // POST /v1/keys/:id/revoke — admin only
  router.post('/:id/revoke', async (req: Request, res: Response) => {
    try {
      const requestId = (req as any).requestId;

      if (!requireAdmin(req, res, cfg.adminApiToken)) {
        return;
      }

      const id = req.params.id as string;
      if (!isValidUuid(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be a valid UUID', 'keys_revoke', requestId));
        return;
      }

      const { reason } = req.body || {};

      const { revokeKey } = await import('../keys/storage.js');
      const revoked = await revokeKey(id, typeof reason === 'string' ? reason : '');

      if (!revoked) {
        res.status(404).json(error('NOT_FOUND', 'Key not found or already revoked', 'keys_revoke', requestId));
        return;
      }

      res.status(200).json(success({ revoked: true }, 'keys_revoke', requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'keys_revoke', (req as any).requestId));
    }
  });

  return router;
}
