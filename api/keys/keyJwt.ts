import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Minimal HS256 JWT implementation using only Node built-in crypto.
 * No external jsonwebtoken dependency — keeps acp-api lean.
 */

function base64UrlEncode(source: Buffer): string {
  return source.toString('base64url');
}

function base64UrlDecode(source: string): Buffer {
  return Buffer.from(source, 'base64url');
}

function sign(data: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(data, 'utf8');
  return base64UrlEncode(hmac.digest());
}

export interface LicenseJwtPayload {
  sub: string;      // key UUID
  tier: string;     // e.g. free_year
  iat: number;      // epoch seconds
  exp: number;      // epoch seconds
}

/**
 * Mint a short-lived offline JWT for the desktop app to cache.
 */
export function mintLicenseJwt(payload: LicenseJwtPayload, secret: string): string {
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const signature = sign(data, secret);
  return `${data}.${signature}`;
}

/**
 * Verify an offline JWT. Returns the payload if valid, null otherwise.
 */
export function verifyLicenseJwt(token: string, secret: string): LicenseJwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, bodyB64, sigB64] = parts;
  if (!headerB64 || !bodyB64 || !sigB64) return null;

  const data = `${headerB64}.${bodyB64}`;
  const expectedSig = sign(data, secret);

  // Timing-safe comparison of base64url strings (equal length guaranteed)
  try {
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    const actualBuf = Buffer.from(sigB64, 'utf8');
    if (expectedBuf.length !== actualBuf.length) return null;
    if (!timingSafeEqual(expectedBuf, actualBuf)) return null;
  } catch {
    return null;
  }

  let payload: LicenseJwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(bodyB64).toString('utf8')) as LicenseJwtPayload;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.iat !== 'number' || payload.iat > now) return null;

  return payload;
}
