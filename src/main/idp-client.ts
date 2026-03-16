/**
 * IDP Client for Main Process
 *
 * All IDP API calls happen here in the main process.
 * No CORS issues, tokens never exposed to renderer.
 */

// Configuration
const IDP_URL = process.env.IDP_URL || 'http://10.0.0.93:32785';
const IDP_INTERNAL_URL = process.env.IDP_INTERNAL_URL || 'http://10.0.0.93:32774';
const CLIENT_ID = 'idealvibe_online';
const IS_DEV = !require('electron').app.isPackaged;

interface IdpError {
  code: string;
  message: string;
}

interface IdpLoginResponse {
  success: boolean;
  result?: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    requires_2fa?: boolean;
    two_factor_complete?: boolean;
    available_2fa_methods?: string[];
    user?: {
      userId?: string;
      email?: string;
      fullName?: string;
      roles?: string[];
      isEmailConfirmed?: boolean;
      isSmsConfirmed?: boolean;
    };
  };
  error?: IdpError;
}

interface IdpRefreshResponse {
  success: boolean;
  data?: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  error?: IdpError;
}

interface Idp2FAResponse {
  success: boolean;
  data?: {
    access_token?: string;
    refresh_token?: string;
    mfa_expires_at?: string;
  };
  error?: IdpError;
}

/**
 * Login with email/password
 * In dev mode, uses /dev/impersonate on internal IDP (no real password needed)
 */
export async function idpLogin(
  email: string,
  password: string
): Promise<IdpLoginResponse> {
  // Dev mode: use impersonate endpoint on internal IDP
  // Always impersonate as admin-user (available personas: free-user, premium-user, admin-user, merchant)
  if (IS_DEV) {
    return idpDevImpersonate('admin-user');
  }

  console.log('[IDP] Login attempt for:', email);

  try {
    const response = await fetch(`${IDP_URL}/api/ExternalAuth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': CLIENT_ID,
      },
      body: JSON.stringify({
        username_or_email: email,
        password,
        client_id: CLIENT_ID,
      }),
    });

    const data = await response.json();
    const responseData = data.data || data;

    if (!response.ok || !responseData.result || !responseData.success) {
      console.log('[IDP] Login failed:', response.status, responseData.error);
      return {
        success: false,
        error: responseData.error || {
          code: `HTTP_${response.status}`,
          message: getLoginErrorMessage(response.status, responseData),
        },
      };
    }

    console.log('[IDP] Login success');
    return {
      success: true,
      result: responseData.result,
    };
  } catch (error) {
    console.error('[IDP] Login request failed:', error);
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: 'Failed to connect to authentication service',
      },
    };
  }
}

/**
 * Dev-only: Impersonate a user via internal IDP TestHarness
 */
async function idpDevImpersonate(persona: string): Promise<IdpLoginResponse> {
  console.log('[IDP] Dev impersonate:', persona);

  try {
    const response = await fetch(`${IDP_INTERNAL_URL}/dev/impersonate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona, clientId: 8 }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[IDP] Impersonate failed:', response.status, errorText);
      return {
        success: false,
        error: { code: `HTTP_${response.status}`, message: `Impersonate failed: ${response.status}` },
      };
    }

    const data = await response.json();
    console.log('[IDP] Impersonate success for:', persona);

    const user = data.user || {};
    return {
      success: true,
      result: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in || 3600,
        requires_2fa: false,
        two_factor_complete: true,
        user: {
          userId: String(user.id || 'dev-user'),
          email: user.email || persona,
          fullName: user.userName || persona,
          roles: user.roles || ['admin'],
        },
      },
    };
  } catch (error) {
    console.error('[IDP] Impersonate request failed:', error);
    return {
      success: false,
      error: { code: 'NETWORK_ERROR', message: 'Failed to connect to internal IDP for impersonation' },
    };
  }
}

/**
 * Refresh access token
 */
export async function idpRefresh(refreshToken: string): Promise<IdpRefreshResponse> {
  console.log('[IDP] Refreshing token...');

  try {
    const response = await fetch(`${IDP_URL}/api/ExternalAuth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': CLIENT_ID,
      },
      body: JSON.stringify({
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      console.log('[IDP] Refresh failed:', response.status);
      return {
        success: false,
        error: {
          code: `HTTP_${response.status}`,
          message: response.status === 401 ? 'Refresh token expired' : 'Token refresh failed',
        },
      };
    }

    const data = await response.json();
    const tokenData = data.data || data;

    console.log('[IDP] Token refreshed');
    return {
      success: true,
      data: {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in || 3600,
      },
    };
  } catch (error) {
    console.error('[IDP] Refresh request failed:', error);
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: 'Failed to connect to authentication service',
      },
    };
  }
}

/**
 * Send 2FA code
 */
export async function idpSend2FA(
  accessToken: string,
  method: 'email' | 'sms'
): Promise<{ success: boolean; error?: IdpError }> {
  console.log('[IDP] Sending 2FA code via:', method);

  try {
    const response = await fetch(`${IDP_URL}/api/ExternalAuth/send-2fa-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ method }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return {
        success: false,
        error: data.error || {
          code: `HTTP_${response.status}`,
          message: 'Failed to send 2FA code',
        },
      };
    }

    console.log('[IDP] 2FA code sent');
    return { success: true };
  } catch (error) {
    console.error('[IDP] Send 2FA failed:', error);
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: 'Failed to connect to authentication service',
      },
    };
  }
}

/**
 * Verify 2FA code
 */
export async function idpVerify2FA(
  accessToken: string,
  code: string,
  method: 'email' | 'sms'
): Promise<Idp2FAResponse> {
  console.log('[IDP] Verifying 2FA code via:', method);

  try {
    const response = await fetch(`${IDP_URL}/api/ExternalAuth/verify-2fa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ code, method }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return {
        success: false,
        error: data.error || {
          code: `HTTP_${response.status}`,
          message: response.status === 401 ? 'Invalid code' : '2FA verification failed',
        },
      };
    }

    const data = await response.json();
    console.log('[IDP] 2FA verified');

    return {
      success: true,
      data: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        mfa_expires_at: data.mfa_expires_at,
      },
    };
  } catch (error) {
    console.error('[IDP] Verify 2FA failed:', error);
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: 'Failed to connect to authentication service',
      },
    };
  }
}

/**
 * Revoke token (logout)
 */
export async function idpRevoke(accessToken: string): Promise<void> {
  console.log('[IDP] Revoking token...');

  try {
    await fetch(`${IDP_URL}/api/ExternalAuth/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({}),
    });
    console.log('[IDP] Token revoked');
  } catch (error) {
    console.warn('[IDP] Revoke failed (non-critical):', error);
  }
}

function getLoginErrorMessage(status: number, responseData: unknown): string {
  const data = responseData as { error?: { message?: string } };
  if (data?.error?.message) {
    return data.error.message;
  }

  switch (status) {
    case 401:
      return 'Invalid email or password';
    case 403:
      return 'Account access denied';
    case 429:
      return 'Too many login attempts. Please try again later.';
    default:
      if (status >= 500) {
        return 'Authentication service is temporarily unavailable';
      }
      return 'Authentication failed';
  }
}
