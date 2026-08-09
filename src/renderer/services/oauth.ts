/**
 * OAuth Service for Electron
 * Handles OAuth flow with external providers via system browser
 */

import {
  IDPClientConfig,
  OAuthProviderConfig,
  OAUTH_ENDPOINTS,
  DEFAULT_SCOPES,
  IDP_CLIENT_APP,
  IDP_CLIENT_APP_HEADER,
} from '@shared/idp-config';
import { getIdpUrl } from './endpoints';
import { createPkcePair } from './pkce';

// No IDP_URL literal here (WO #292) — the IDP base URL comes from the
// main-process env authority via the cloud:endpoints IPC (resolved per call).
const CLIENT_ID = 'idealvibe_online';

// Callback URL for OAuth - uses localhost server in Electron
const OAUTH_CALLBACK_PORT = 40021;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/oauth/callback`;

// ============================================================================
// IDP CONFIG FETCHING
// ============================================================================

let cachedConfig: IDPClientConfig | null = null;
let cacheExpiry = 0;
let inFlightPromise: Promise<IDPClientConfig> | null = null;

/**
 * Fetch IDP client configuration.
 * Contains OAuth provider list with credentials.
 */
export async function getIDPClientConfig(forceRefresh = false): Promise<IDPClientConfig> {
  const now = Date.now();

  if (!forceRefresh && cachedConfig && now < cacheExpiry) {
    return cachedConfig;
  }

  // Deduplicate concurrent calls — all callers waiting on the same
  // in-flight promise share one network round-trip.
  if (inFlightPromise) {
    return inFlightPromise;
  }

  inFlightPromise = (async () => {
    try {
      console.log('[OAuth] Fetching IDP client config...');

      const idpUrl = await getIdpUrl(); // env authority (IPC), no literal

      // Step 1: Get signed client assertion
      const signingResp = await fetch(`${idpUrl}/api/ExternalAuth/sign-client-assertion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': CLIENT_ID,
          [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
        },
        body: JSON.stringify({
          issuer: CLIENT_ID,
          subject: CLIENT_ID,
          audience: 'urn:payez:externalauth:clientconfig',
          expires_in: 60,
        }),
      });

      if (!signingResp.ok) {
        throw new Error(`Failed to sign client assertion: ${signingResp.status}`);
      }

      const signingData = await signingResp.json();
      const clientAssertion = signingData?.data?.client_assertion || signingData?.data?.clientAssertion;

      if (!clientAssertion) {
        throw new Error('IDP did not return client_assertion');
      }

      // Step 2: Fetch client config
      const configResp = await fetch(`${idpUrl}/api/ExternalAuth/client-config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': CLIENT_ID,
          [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
        },
        body: JSON.stringify({ client_assertion: clientAssertion }),
      });

      if (!configResp.ok) {
        throw new Error(`Failed to fetch client config: ${configResp.status}`);
      }

      const configBody = await configResp.json();
      const configData = configBody?.data;

      if (!configData) {
        throw new Error('IDP did not return config data');
      }

      // Map response to our interface
      const config: IDPClientConfig = {
        clientId: configData.clientId ?? configData.client_id,
        clientSlug: configData.clientSlug ?? configData.client_slug ?? '',
        configCacheTtlSeconds: configData.configCacheTtlSeconds ?? configData.config_cache_ttl_seconds ?? 300,
        oauthProviders: (configData.oauthProviders ?? configData.oauth_providers ?? []).map((p: Record<string, unknown>) => ({
          provider: p.provider ?? '',
          enabled: p.enabled ?? false,
          clientId: p.clientId ?? p.client_id ?? '',
          // clientSecret intentionally NOT mapped (175295) — even though the IDP's
          // response may still include one, this config object never needs to hold
          // it now that the token exchange happens server-side. Not capturing it
          // here means it never sits in renderer memory at all, not just "unused."
          scopes: p.scopes as string | undefined,
          additionalParams: (p.additionalParams ?? p.additional_params) as Record<string, string> | undefined,
        })),
        authSettings: {
          require2FA: configData.authSettings?.require2FA ?? configData.auth_settings?.require_2fa ?? true,
          allowed2FAMethods: configData.authSettings?.allowed2FAMethods ?? configData.auth_settings?.allowed_2fa_methods ?? ['email'],
          mfaGracePeriodHours: configData.authSettings?.mfaGracePeriodHours ?? 24,
          sessionTimeoutMinutes: configData.authSettings?.sessionTimeoutMinutes ?? 60,
          allowRememberMe: configData.authSettings?.allowRememberMe ?? true,
          rememberMeDays: configData.authSettings?.rememberMeDays ?? 30,
        },
      };

      // Cache it
      cachedConfig = config;
      cacheExpiry = now + config.configCacheTtlSeconds * 1000;

      console.log('[OAuth] Config loaded, providers:', config.oauthProviders.filter(p => p.enabled).map(p => p.provider));

      return config;
    } finally {
      inFlightPromise = null;
    }
  })();

  return inFlightPromise;
}

/**
 * Get enabled OAuth providers
 */
export async function getEnabledOAuthProviders(): Promise<OAuthProviderConfig[]> {
  const config = await getIDPClientConfig();
  return config.oauthProviders.filter(p => p.enabled);
}

// ============================================================================
// OAUTH URL BUILDING
// ============================================================================

/**
 * Generate a cryptographically random state parameter
 */
function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Store OAuth state for verification.
 *
 * codeVerifier is REQUIRED, not optional, as of 175295 — every authorization
 * attempt generates one and it is the only thing that lets the IDP-exchange
 * leg (exchangeCodeWithIDP) prove this callback belongs to the request that
 * started it, now that the desktop never sees a provider client_secret to
 * prove anything else.
 */
let pendingOAuthState: { state: string; provider: string; codeVerifier: string } | null = null;

export function getPendingOAuthState() {
  return pendingOAuthState;
}

export function clearPendingOAuthState() {
  pendingOAuthState = null;
}

/**
 * Build OAuth authorize URL for a provider
 */
export async function buildOAuthUrl(providerName: string): Promise<string> {
  const config = await getIDPClientConfig();
  const provider = config.oauthProviders.find(
    p => p.enabled && p.provider.toLowerCase() === providerName.toLowerCase()
  );

  if (!provider) {
    throw new Error(`OAuth provider ${providerName} not enabled`);
  }

  const endpoints = OAUTH_ENDPOINTS[providerName.toLowerCase()];
  if (!endpoints) {
    throw new Error(`Unknown OAuth provider: ${providerName}`);
  }

  const state = generateState();
  const scopes = provider.scopes || DEFAULT_SCOPES[providerName.toLowerCase()] || 'openid email profile';

  // 175295 — PKCE (RFC 7636). See pkce.ts header for the full design rationale
  // (BAPert 21218): the token EXCHANGE moves server-side to the IDP (which
  // already holds the provider's client_secret), so the desktop never needs
  // one. This code_challenge is what lets the IDP redeem this SPECIFIC
  // authorization attempt — without it, whoever's holding the callback
  // request's `code` could redeem it on their own, secret or no secret.
  const { codeVerifier, codeChallenge, codeChallengeMethod } = await createPkcePair();

  // Store state for verification
  pendingOAuthState = { state, provider: providerName, codeVerifier };

  // Build authorize URL
  let authorizeUrl = endpoints.authorize;

  // Handle Microsoft tenant
  if (providerName.toLowerCase() === 'microsoft') {
    const tenant = provider.additionalParams?.tenantId || 'common';
    authorizeUrl = authorizeUrl.replace('{tenant}', tenant);
  }

  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
  });

  // Provider-specific params
  if (providerName.toLowerCase() === 'google') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }

  console.log('[OAuth] Built authorize URL for', providerName);

  return `${authorizeUrl}?${params.toString()}`;
}

// ============================================================================
// IDP-MEDIATED TOKEN EXCHANGE (175295)
// ============================================================================
//
// REMOVED FROM THIS FILE, ON PURPOSE: exchangeCodeForTokens (POSTed
// client_secret straight to the provider's token endpoint) and fetchUserInfo
// (called the provider's userinfo endpoint with the resulting access token).
// Both required the renderer to hold a provider client_secret in memory,
// fetched via getIDPClientConfig — a secret shipped to and readable on every
// fielded desktop machine (175295, confirmed from source 3x). Deleted rather
// than left dead: a working-but-unused client_secret path is a loaded gun
// someone could re-wire back in. OAuthProviderConfig.clientSecret is REMOVED
// from the type too (@shared/idp-config.ts) — the field only ever existed to
// be mapped in from the IDP's /client-config response and then never read
// again, which still put the real secret value in renderer memory even
// though nothing used it. The IDP's /client-config response including a
// client_secret at all is a separate, tracked cleanup on the same card.
//
// REPLACEMENT: the desktop now only ever gets an authorization `code` back
// (via the local callback server) and hands it, plus the PKCE code_verifier
// generated in buildOAuthUrl, to the IDP via exchangeCodeWithIDP below. The
// IDP — which already holds every provider's client_secret server-side —
// performs the actual provider token exchange, fetches user info, and mints
// IDP tokens. The desktop never talks to a provider's token or userinfo
// endpoint again.
// ============================================================================

// ============================================================================
// IDP OAUTH CALLBACK
// ============================================================================

interface IDPOAuthResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  user?: {
    userId: string;
    email: string;
    fullName: string;
    roles: string[];
  };
  error?: { code: string; message: string };
}

/**
 * 175295 — PKCE code redemption via the IDP, replacing the renderer-side Google call.
 *
 * WHY THIS EXISTS
 * The renderer used to POST `client_secret` straight to the provider's token endpoint
 * (the now-deleted exchangeCodeForTokens — see the section header above), which made the
 * secret extractable from a shipped Electron build. Jon accepted that knowingly and
 * temporarily. This is the permanent fix: the code and the PKCE verifier go to our IDP, the
 * IDP holds the secret and calls the provider server-side, and the renderer never sees a
 * client secret again.
 *
 * THREE REQUIREMENTS, each verified against the live endpoint 2026-08-09:
 *   1. `X-Client-Id` is MANDATORY. Omitting it returns 404, NOT 401 — a missing-header
 *      failure is indistinguishable from a missing route, and it cost several hours of
 *      "the endpoint is not deployed" tonight. Send it or the call silently looks absent.
 *   2. The body is snake_case (`code_verifier`, `redirect_uri`), not camelCase.
 *   3. The client is identified by SLUG, never a numeric id — CLIENT_ID is
 *      'idealvibe_online' and the IDP resolves it. Deriving it from a token does not apply
 *      here (BAPert's own ruling, withdrawn: the exchange is what OBTAINS the token, so
 *      there is nothing to derive from yet). Whether 'idealvibe_online' is the CORRECT
 *      tenant for this desktop client is a separate, pre-existing, carded question — it
 *      predates this change (shipped today, 5 sites across acp-desktop + acp-api) and
 *      this fix does not touch it.
 *
 * WIRED IN: completeOAuthFlow calls this directly. This function, the PKCE wiring in
 * buildOAuthUrl, and the deletion of exchangeCodeForTokens/fetchUserInfo/registerWithIDP
 * are one change (175295), not staged separately — a half-applied version would either
 * still hold the client_secret or send a code with no verifier to redeem it.
 */
export async function exchangeCodeWithIDP(
  providerName: string,
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<IDPOAuthResult> {
  console.log('[OAuth] Redeeming code via IDP (no client_secret in renderer):', { provider: providerName });

  const idpUrl = await getIdpUrl(); // env authority (IPC), no literal
  const response = await fetch(`${idpUrl}/api/ExternalAuth/oauth-exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': CLIENT_ID, // MANDATORY — omitting this 404s, see (1) above
      [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
    },
    body: JSON.stringify({
      provider: providerName,
      code,
      code_verifier: codeVerifier, // snake_case — see (2) above
      redirect_uri: redirectUri,
      app: IDP_CLIENT_APP,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[OAuth] IDP code exchange failed:', response.status, error);
    // Surface the IDP's own code/message (VALIDATION_ERROR, INVALID_CLIENT_ID,
    // PROVIDER_NOT_CONFIGURED, PROVIDER_SECRET_MISSING, CODE_EXCHANGE_FAILED —
    // see NightHawk's live probe, 23895) rather than a generic thrown error
    // that would collapse all of them into completeOAuthFlow's catch-all
    // OAUTH_FAILED. The whole point of naming the failing hop is lost if the
    // caller never sees which hop named itself.
    let code2 = `HTTP_${response.status}`;
    // 404 = X-Client-Id absent or names an unknown client — both resolved BEFORE the
    // exchange runs. A REFUSED code is a 401 CODE_EXCHANGE_FAILED, never a 404 (corrected
    // per QAPert-NightHawk 23919: the handler brace-matches to 0 NotFound / 9 specific
    // error codes, so it cannot 404 on its own — every 404 is upstream client resolution).
    let message =
      response.status === 404
        ? '404 from this endpoint means the client identity did not resolve — a missing X-Client-Id header or an unknown slug. It is never a refused code (that is 401 CODE_EXCHANGE_FAILED) and it does not mean the route is absent.'
        : 'OAuth exchange failed';
    try {
      const parsed = JSON.parse(error);
      if (parsed?.error?.code) code2 = parsed.error.code;
      if (parsed?.error?.message) message = parsed.error.message;
      const requestId = parsed?.request_id ?? parsed?.error?.support?.request_id;
      if (requestId) message += ` (request_id ${requestId})`;
    } catch {
      /* non-JSON body — keep the status-derived code/message */
    }
    return { success: false, error: { code: code2, message } };
  }

  const data = await response.json();
  const result = data.data || data;

  if (result.success === false) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    accessToken: result.accessToken || result.access_token,
    refreshToken: result.refreshToken || result.refresh_token,
    user: result.user
      ? {
          userId: result.user.userId || result.user.user_id,
          email: result.user.email,
          fullName: result.user.fullName || result.user.full_name || result.user.name,
          roles: result.user.roles || [],
        }
      : undefined,
  };
}

// ============================================================================
// FULL OAUTH FLOW
// ============================================================================

/**
 * Complete OAuth flow after receiving callback.
 *
 * 175295 — one call. The desktop never sees a provider access/refresh/id
 * token or a client_secret — the IDP redeems the code (with the
 * code_verifier proving this callback belongs to the attempt that started
 * it), fetches the provider's user info, and mints IDP tokens, all
 * server-side. This REPLACES the old exchangeCodeForTokens -> fetchUserInfo
 * -> registerWithIDP(oauth-callback) chain, which is why those three are
 * gone from this file rather than left unused beside this function.
 */
export async function completeOAuthFlow(
  code: string,
  state: string
): Promise<IDPOAuthResult> {
  // Verify state
  if (!pendingOAuthState || pendingOAuthState.state !== state) {
    return {
      success: false,
      error: { code: 'INVALID_STATE', message: 'OAuth state mismatch' },
    };
  }

  const providerName = pendingOAuthState.provider;
  const codeVerifier = pendingOAuthState.codeVerifier;
  clearPendingOAuthState();

  try {
    console.log('[OAuth] Exchanging code via IDP...');
    const result = await exchangeCodeWithIDP(providerName, code, codeVerifier, OAUTH_REDIRECT_URI);

    return result;
  } catch (error) {
    console.error('[OAuth] Flow failed:', error);
    return {
      success: false,
      error: {
        code: 'OAUTH_FAILED',
        message: error instanceof Error ? error.message : 'OAuth flow failed',
      },
    };
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_REDIRECT_URI };
export type { OAuthProviderConfig } from '@shared/idp-config';
