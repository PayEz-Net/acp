/**
 * Vibe Public API HMAC request signer.
 *
 * ACP authenticates to the cloud vibe-api using the HMAC signing path
 * (`X-Vibe-Client-Id` + `X-Vibe-Timestamp` + `X-Vibe-Signature`), NOT the
 * Enterprise client-secret path. The two are completely separate auth
 * models — the Enterprise path stores a BCrypt-hashed secret on the
 * server and was being used incorrectly before this module existed,
 * which led to a cascade of `BCrypt.SaltParseException` 500s when the
 * server tried to verify a signing key as if it were a password.
 *
 * Server-side recipe, mirrored from
 * PayEz.Vibe.Public.Api/Middleware/VibeClientAuthMiddleware.cs
 * ComputeHmacSignature(...):
 *
 *     keyBytes  = Base64Decode(signingKey)
 *     dataBytes = UTF8("{unixTimestamp}|{METHOD}|{path}")
 *     signature = Base64( HMAC-SHA256(keyBytes, dataBytes) )
 *
 * Headers the server expects:
 *   X-Vibe-Client-Id:  <client id, e.g. vibe_abc123>
 *   X-Vibe-Timestamp:  <unix epoch seconds as a string>
 *   X-Vibe-Signature:  <base64 signature>
 *
 * Constraints:
 *   - path MUST NOT include the query string — server reads
 *     `context.Request.Path.Value` which is path only
 *   - timestamp MUST be within MaxTimestampAge (5 min) of server clock
 *   - method is upper-cased on both sides
 */

import { createHmac } from 'crypto';

export interface VibeHmacConfig {
  clientId: string;
  signingKey: string; // base64-encoded 32-byte key
}

export interface VibeHmacHeaders {
  'X-Vibe-Client-Id': string;
  'X-Vibe-Timestamp': string;
  'X-Vibe-Signature': string;
}

/**
 * Compute the HMAC signature for a given (method, path, timestamp) tuple.
 * Exported mainly for tests; callers should prefer `signVibeRequest` which
 * fills in the current timestamp and returns the full header bundle.
 */
export function computeVibeHmacSignature(
  method: string,
  path: string,
  timestamp: string,
  signingKey: string,
): string {
  const keyBuf = Buffer.from(signingKey, 'base64');
  const stringToSign = `${timestamp}|${method.toUpperCase()}|${path}`;
  const hmac = createHmac('sha256', keyBuf);
  hmac.update(stringToSign, 'utf8');
  return hmac.digest('base64');
}

/**
 * Build the three X-Vibe-* headers for an outbound request to the cloud
 * vibe-api. Strips any query string from the path because the server
 * signs the path-only portion of the URL.
 */
export function signVibeRequest(
  method: string,
  pathWithPossibleQuery: string,
  cfg: VibeHmacConfig,
): VibeHmacHeaders {
  const qIdx = pathWithPossibleQuery.indexOf('?');
  const path = qIdx === -1 ? pathWithPossibleQuery : pathWithPossibleQuery.slice(0, qIdx);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = computeVibeHmacSignature(method, path, timestamp, cfg.signingKey);
  return {
    'X-Vibe-Client-Id': cfg.clientId,
    'X-Vibe-Timestamp': timestamp,
    'X-Vibe-Signature': signature,
  };
}

/**
 * Convenience wrapper: given an absolute URL, extract the path portion
 * and sign it. Useful for call sites that build full URLs upfront and
 * don't want to split path/host themselves.
 */
export function signVibeRequestFromUrl(
  method: string,
  fullUrl: string,
  cfg: VibeHmacConfig,
): VibeHmacHeaders {
  const u = new URL(fullUrl);
  return signVibeRequest(method, u.pathname, cfg);
}
