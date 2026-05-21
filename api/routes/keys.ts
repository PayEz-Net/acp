import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { config, type Config } from '../../config.js';
import { looksLikeKey, normalizeKey, hashKey, keyPrefix } from '../keys/keyCodec.js';
import { mintLicenseJwt } from '../keys/keyJwt.js';
import { findKeyByHash, redeemKey } from '../keys/storage.js';

const JWT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export default function keyRoutes(cfg: Config = config): Router {
  const router = Router();

  // POST /v1/keys/validate — public (added to PUBLIC_PATHS in localAuth.ts)
  router.post('/validate', async (req: Request, res: Response) => {
    try {
      const { key } = req.body || {};
      const requestId = (req as any).requestId;

      if (!key || typeof key !== 'string') {
        res.status(400).json(error('VALIDATION_ERROR', 'key is required', 'keys_validate', requestId));
        return;
      }

      if (!looksLikeKey(key)) {
        res.status(400).json(error('VALIDATION_ERROR', 'key format invalid', 'keys_validate', requestId));
        return;
      }

      const normalized = normalizeKey(key);
      const keyHash = hashKey(normalized);
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

      const iat = Math.floor(Date.now() / 1000);
      const offlineJwt = mintLicenseJwt(
        {
          sub: row.id,
          tier: row.tier,
          iat,
          exp: iat + JWT_TTL_SECONDS,
        },
        cfg.licenseJwtSecret,
      );

      res.status(200).json(success({
        valid: true,
        keyId: row.id,
        tier: row.tier,
        expiresAt: row.expires_at,
        offlineJwt,
      }, 'keys_validate', requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'keys_validate', (req as any).requestId));
    }
  });

  // POST /v1/keys/:id/revoke — admin only
  router.post('/:id/revoke', async (req: Request, res: Response) => {
    try {
      const requestId = (req as any).requestId;
      const rawAdminToken = req.headers['x-admin-token'];
      const adminToken = Array.isArray(rawAdminToken) ? rawAdminToken[0] : rawAdminToken;

      if (!cfg.adminApiToken) {
        res.status(500).json(error('INTERNAL_ERROR', 'Admin token not configured', 'keys_revoke', requestId));
        return;
      }

      if (!adminToken || adminToken !== cfg.adminApiToken) {
        res.status(403).json(error('FORBIDDEN', 'Invalid admin token', 'keys_revoke', requestId));
        return;
      }

      const id = req.params.id as string;
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
