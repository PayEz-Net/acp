/**
 * Token Manager for ACP API
 *
 * Manages Bearer tokens for Vibe API calls.
 * Tokens are stored in memory (single user desktop app).
 *
 * expiresAt is derived from the JWT's own `exp` claim — not from an
 * `expires_in` field in the wrapping response — because the External ID API
 * login payload doesn't include expires_in, and the IDP session can be
 * shorter than any default we'd invent. Trusting the JWT is the only way
 * ensureValidToken() can actually trigger a refresh before upstream rejects.
 */

interface TokenSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  userId: string;
  email: string;
}

let currentSession: TokenSession | null = null;

// Single-flight guard for refreshToken. The IDP issues single-use refresh
// tokens, so parallel refresh calls guarantee failure: the first rotates
// the token, the rest send the now-invalid original and get back
// INVALID_REFRESH_TOKEN. When multiple callers (SSE streams, mail proxy
// retries) need a refresh simultaneously, they must all await the same
// in-flight promise and share its result.
let inflightRefresh: Promise<boolean> | null = null;

function decodeJwtExp(token: string): Date | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    if (typeof payload.exp === 'number') {
      return new Date(payload.exp * 1000);
    }
    return null;
  } catch {
    return null;
  }
}

export function setSession(session: TokenSession): void {
  // If the caller passed an access token, prefer the JWT's own exp claim.
  const jwtExp = decodeJwtExp(session.accessToken);
  currentSession = {
    ...session,
    expiresAt: jwtExp ?? session.expiresAt,
  };
}

export function getSession(): TokenSession | null {
  return currentSession;
}

export function clearSession(): void {
  currentSession = null;
}

export function getAccessToken(): string | null {
  return currentSession?.accessToken || null;
}

export function isTokenValid(): boolean {
  if (!currentSession) return false;
  // Refresh if token expires in the next 60 seconds.
  const soon = new Date(Date.now() + 60 * 1000);
  return currentSession.expiresAt > soon;
}

export async function refreshToken(idpUrl: string): Promise<boolean> {
  // Single-flight: if a refresh is already in progress, await its result
  // rather than launching a parallel call that'll burn the single-use
  // refresh_token. Every caller in the same microsecond window shares one
  // upstream round-trip and one outcome.
  if (inflightRefresh) {
    return inflightRefresh;
  }

  if (!currentSession?.refreshToken) {
    console.warn('[Auth] refresh skipped: no refresh token in session');
    return false;
  }

  inflightRefresh = (async (): Promise<boolean> => {
    // Re-read currentSession inside the promise — by the time we actually
    // run, another caller might have already populated inflightRefresh and
    // we'd double-check, but the outer guard above makes that unreachable.
    const refreshTokenValue = currentSession!.refreshToken!;

    try {
      const response = await fetch(`${idpUrl}/api/ExternalAuth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'idealvibe_online',
        },
        body: JSON.stringify({ refresh_token: refreshTokenValue }),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '(unreadable)');
        console.error(`[Auth] refresh failed: IDP returned ${response.status} — ${errBody.slice(0, 500)}`);
        return false;
      }

      const body = await response.json();
      const payload = body?.data ?? body;
      const accessToken = payload?.access_token;
      if (!accessToken) {
        console.error('[Auth] refresh failed: IDP response had no access_token', { bodyKeys: Object.keys(body || {}), payloadKeys: Object.keys(payload || {}) });
        return false;
      }

      const jwtExp = decodeJwtExp(accessToken);
      currentSession = {
        accessToken,
        refreshToken: payload?.refresh_token || currentSession!.refreshToken,
        expiresAt: jwtExp ?? new Date(Date.now() + 15 * 60 * 1000),
        userId: payload?.user?.userId || currentSession!.userId,
        email: payload?.user?.email || currentSession!.email,
      };
      console.log(`[Auth] refresh ok, expires ${currentSession.expiresAt.toISOString()}`);

      return true;
    } catch (err: any) {
      console.error(`[Auth] refresh threw: ${err?.message || err}`);
      return false;
    } finally {
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

export async function ensureValidToken(idpUrl: string): Promise<string | null> {
  if (!currentSession) return null;

  if (!isTokenValid() && currentSession.refreshToken) {
    const refreshed = await refreshToken(idpUrl);
    if (!refreshed) return null;
  }

  return currentSession.accessToken;
}

/**
 * Force a refresh regardless of local expiry. Called by mailProxy when the
 * cloud returns 401 despite our local check saying the token is valid —
 * the IDP session may have been invalidated out-of-band.
 */
export async function forceRefresh(idpUrl: string): Promise<string | null> {
  if (!currentSession?.refreshToken) return null;
  const ok = await refreshToken(idpUrl);
  if (!ok) return null;
  return currentSession?.accessToken ?? null;
}
