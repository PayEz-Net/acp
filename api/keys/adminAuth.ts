import type { Request, Response } from 'express';

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Require a valid admin Bearer token on the request.
 * Fail-closed: returns false and sends response if auth fails.
 */
export function requireAdmin(req: Request, res: Response, expectedToken: string | undefined): boolean {
  if (!expectedToken) {
    res.status(503).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'Admin API not configured' } });
    return false;
  }

  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match || !timingSafeEqualStr(match[1], expectedToken)) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    return false;
  }

  return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id: string): boolean {
  return UUID_RE.test(id);
}
