/**
 * OAuth Service for Electron
 * Handles OAuth flow with external providers via system browser
 */

import {
  IDPClientConfig,
  OAuthProviderConfig,
  OAUTH_ENDPOINTS,
  DEFAULT_SCOPES,
} from '@shared/idp-config';

// @ts-expect-error Vite provides import.meta.env
const env = import.meta.env;
const IDP_URL = env?.VITE_IDP_URL || (env?.DEV ? 'http://localhost:32785' : 'https://idp.payez.net');
const CLIENT_SECRET = env?.VITE_PAYEZ_CLIENT_SECRET || '';

const CLIENT_ID = 'idealvibe_online';

// Callback URL for OAuth - uses localhost server in Electron
const OAUTH_CALLBACK_PORT = 40021;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/oauth/callback`;

// ============================================================================
// IDP CONFIG FETCHING
// ============================================================================

let cachedConfig: IDPClientConfig | null = null;
let cacheExpiry = 0;

/**
 * Fetch IDP client configuration.
 * Contains OAuth provider list with credentials.
 */
export async function getIDPClientConfig(forceRefresh = false): Promise<IDPClientConfig> {
  const now = Date.now();

  if (!forceRefresh && cachedConfig && now < cacheExpiry) {
    return cachedConfig;
  }

  console.log('[OAuth] Fetching IDP client config...');

  // Step 1: Get signed client assertion
  const signingResp = await fetch(`${IDP_URL}/api/ExternalAuth/sign-client-assertion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': CLIENT_ID,
    },
    body: JSON.stringify({
      issuer: CLIENT_ID,
      subject: CLIENT_ID,
      audience: 'urn:payez:externalauth:clientconfig',
      expires_in: 60,
      client_secret: CLIENT_SECRET,
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
  const configResp = await fetch(`${IDP_URL}/api/ExternalAuth/client-config`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': CLIENT_ID,
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
      clientSecret: p.clientSecret ?? p.client_secret ?? '',
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
 * Store OAuth state for verification
 */
let pendingOAuthState: { state: string; provider: string; codeVerifier?: string } | null = null;

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

  // Store state for verification
  pendingOAuthState = { state, provider: providerName };

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
// OAUTH TOKEN EXCHANGE
// ============================================================================

interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  providerName: string,
  code: string
): Promise<OAuthTokens> {
  const config = await getIDPClientConfig();
  const provider = config.oauthProviders.find(
    p => p.provider.toLowerCase() === providerName.toLowerCase()
  );

  if (!provider) {
    throw new Error(`Provider ${providerName} not found`);
  }

  const endpoints = OAUTH_ENDPOINTS[providerName.toLowerCase()];
  if (!endpoints) {
    throw new Error(`Unknown provider: ${providerName}`);
  }

  let tokenUrl = endpoints.token;

  // Handle Microsoft tenant
  if (providerName.toLowerCase() === 'microsoft') {
    const tenant = provider.additionalParams?.tenantId || 'common';
    tokenUrl = tokenUrl.replace('{tenant}', tenant);
  }

  const params = new URLSearchParams({
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code,
    redirect_uri: OAUTH_REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[OAuth] Token exchange failed:', error);
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    expiresIn: data.expires_in,
  };
}

// ============================================================================
// USER INFO FETCHING
// ============================================================================

interface OAuthUserInfo {
  id: string;
  email: string;
  name?: string;
  picture?: string;
}

/**
 * Fetch user info from OAuth provider
 */
export async function fetchUserInfo(
  providerName: string,
  accessToken: string
): Promise<OAuthUserInfo> {
  const provider = providerName.toLowerCase();

  let userInfoUrl: string;
  let headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };

  switch (provider) {
    case 'google':
      userInfoUrl = 'https://www.googleapis.com/oauth2/v2/userinfo';
      break;
    case 'microsoft':
      userInfoUrl = 'https://graph.microsoft.com/v1.0/me';
      break;
    case 'github':
      userInfoUrl = 'https://api.github.com/user';
      headers['Accept'] = 'application/vnd.github+json';
      break;
    case 'facebook':
      userInfoUrl = `https://graph.facebook.com/me?fields=id,email,name,picture&access_token=${accessToken}`;
      headers = {}; // Token in URL for Facebook
      break;
    default:
      throw new Error(`User info not supported for: ${provider}`);
  }

  const response = await fetch(userInfoUrl, { headers });

  if (!response.ok) {
    throw new Error(`Failed to fetch user info: ${response.status}`);
  }

  const data = await response.json();

  // Normalize response
  switch (provider) {
    case 'google':
      return {
        id: data.id,
        email: data.email,
        name: data.name,
        picture: data.picture,
      };
    case 'microsoft':
      return {
        id: data.id,
        email: data.mail || data.userPrincipalName,
        name: data.displayName,
      };
    case 'github':
      // GitHub might not return email in main response
      return {
        id: String(data.id),
        email: data.email || '',
        name: data.name || data.login,
        picture: data.avatar_url,
      };
    case 'facebook':
      return {
        id: data.id,
        email: data.email,
        name: data.name,
        picture: data.picture?.data?.url,
      };
    default:
      return { id: data.id || data.sub, email: data.email, name: data.name };
  }
}

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
 * Register OAuth user with IDP and get IDP tokens
 */
export async function registerWithIDP(
  providerName: string,
  providerAccountId: string,
  email: string,
  name: string,
  picture?: string,
  providerAccessToken?: string,
  providerRefreshToken?: string
): Promise<IDPOAuthResult> {
  console.log('[OAuth] Registering with IDP:', { provider: providerName, email });

  const response = await fetch(`${IDP_URL}/api/ExternalAuth/oauth-callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': CLIENT_ID,
    },
    body: JSON.stringify({
      provider: providerName,
      provider_account_id: providerAccountId,
      email,
      name: name || '',
      image: picture || '',
      access_token: providerAccessToken || '',
      refresh_token: providerRefreshToken || '',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[OAuth] IDP registration failed:', error);
    return {
      success: false,
      error: { code: `HTTP_${response.status}`, message: 'OAuth registration failed' },
    };
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
 * Complete OAuth flow after receiving callback
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
  clearPendingOAuthState();

  try {
    // Exchange code for tokens
    console.log('[OAuth] Exchanging code for tokens...');
    const tokens = await exchangeCodeForTokens(providerName, code);

    // Fetch user info
    console.log('[OAuth] Fetching user info...');
    const userInfo = await fetchUserInfo(providerName, tokens.accessToken);

    // Register with IDP
    console.log('[OAuth] Registering with IDP...');
    const result = await registerWithIDP(
      providerName,
      userInfo.id,
      userInfo.email,
      userInfo.name || '',
      userInfo.picture,
      tokens.accessToken,
      tokens.refreshToken
    );

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
