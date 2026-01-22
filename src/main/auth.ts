/**
 * Auth Module for Main Process
 *
 * Manages authentication state, token storage, and IPC handlers.
 * Tokens are stored encrypted and never exposed to renderer.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, AuthStatus, AuthUser, LoginResult, TwoFactorResult } from '../shared/types';
import { idpLogin, idpRefresh, idpSend2FA, idpVerify2FA, idpRevoke } from './idp-client';
import { getAuthSession, setAuthSession, clearAuthSession } from './store';

// Internal session structure (stored encrypted)
interface StoredSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  user: AuthUser;
  requires2FA: boolean;
  twoFactorComplete: boolean;
  available2FAMethods?: string[];
}

/**
 * Parse JWT payload without verification (for extracting claims)
 */
function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Get current auth status (safe to expose to renderer)
 */
function getAuthStatus(): AuthStatus {
  const sessionJson = getAuthSession();
  if (!sessionJson) {
    return {
      isAuthenticated: false,
      user: null,
      requires2FA: false,
      twoFactorComplete: false,
      expiresAt: null,
    };
  }

  try {
    const session: StoredSession = JSON.parse(sessionJson);

    // Check if token is expired
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      return {
        isAuthenticated: false,
        user: session.user,
        requires2FA: false,
        twoFactorComplete: false,
        expiresAt: null,
      };
    }

    return {
      isAuthenticated: session.twoFactorComplete || !session.requires2FA,
      user: session.user,
      requires2FA: session.requires2FA,
      twoFactorComplete: session.twoFactorComplete,
      expiresAt: session.expiresAt,
    };
  } catch {
    return {
      isAuthenticated: false,
      user: null,
      requires2FA: false,
      twoFactorComplete: false,
      expiresAt: null,
    };
  }
}

/**
 * Get stored session (internal use only)
 */
function getStoredSession(): StoredSession | null {
  const sessionJson = getAuthSession();
  if (!sessionJson) return null;
  try {
    return JSON.parse(sessionJson);
  } catch {
    return null;
  }
}

/**
 * Save session to encrypted store
 */
function saveSession(session: StoredSession): void {
  setAuthSession(JSON.stringify(session));
}

/**
 * Handle login request
 */
async function handleLogin(email: string, password: string): Promise<LoginResult> {
  const result = await idpLogin(email, password);

  if (!result.success || !result.result) {
    return {
      success: false,
      error: result.error?.message || 'Login failed',
    };
  }

  const { access_token, refresh_token, expires_in, requires_2fa, two_factor_complete, available_2fa_methods, user } = result.result;

  // Parse token for user info
  const tokenPayload = parseJwtPayload(access_token);

  const authUser: AuthUser = {
    id: (tokenPayload?.sub as string) || user?.userId || '',
    email: (tokenPayload?.email as string) || user?.email || email,
    name: (tokenPayload?.name as string) || user?.fullName || '',
    roles: (tokenPayload?.roles as string[]) || user?.roles || [],
  };

  const session: StoredSession = {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: new Date(Date.now() + (expires_in || 3600) * 1000).toISOString(),
    user: authUser,
    requires2FA: requires_2fa ?? true,
    twoFactorComplete: two_factor_complete ?? false,
    available2FAMethods: available_2fa_methods,
  };

  saveSession(session);

  console.log('[Auth] Login successful, requires2FA:', session.requires2FA);

  return {
    success: true,
    requires2FA: session.requires2FA && !session.twoFactorComplete,
    available2FAMethods: session.available2FAMethods,
  };
}

/**
 * Handle logout request
 */
async function handleLogout(): Promise<void> {
  const session = getStoredSession();

  if (session?.accessToken) {
    await idpRevoke(session.accessToken);
  }

  clearAuthSession();
  console.log('[Auth] Logged out');
}

/**
 * Handle token refresh
 */
async function handleRefresh(): Promise<{ success: boolean; error?: string }> {
  const session = getStoredSession();

  if (!session?.refreshToken) {
    return { success: false, error: 'No refresh token' };
  }

  const result = await idpRefresh(session.refreshToken);

  if (!result.success || !result.data) {
    clearAuthSession();
    return { success: false, error: result.error?.message || 'Refresh failed' };
  }

  const updatedSession: StoredSession = {
    ...session,
    accessToken: result.data.access_token,
    refreshToken: result.data.refresh_token || session.refreshToken,
    expiresAt: new Date(Date.now() + (result.data.expires_in || 3600) * 1000).toISOString(),
  };

  saveSession(updatedSession);
  console.log('[Auth] Token refreshed');

  return { success: true };
}

/**
 * Handle send 2FA code
 */
async function handleSend2FA(method: 'email' | 'sms'): Promise<{ success: boolean; error?: string }> {
  const session = getStoredSession();

  if (!session?.accessToken) {
    return { success: false, error: 'No session' };
  }

  const result = await idpSend2FA(session.accessToken, method);

  if (!result.success) {
    return { success: false, error: result.error?.message || 'Failed to send code' };
  }

  return { success: true };
}

/**
 * Handle verify 2FA code
 */
async function handleVerify2FA(code: string, method: 'email' | 'sms'): Promise<TwoFactorResult> {
  const session = getStoredSession();

  if (!session?.accessToken) {
    return { success: false, error: 'No session' };
  }

  const result = await idpVerify2FA(session.accessToken, code, method);

  if (!result.success) {
    return { success: false, error: result.error?.message || 'Invalid code' };
  }

  // Update session with new tokens if provided
  const updatedSession: StoredSession = {
    ...session,
    accessToken: result.data?.access_token || session.accessToken,
    refreshToken: result.data?.refresh_token || session.refreshToken,
    twoFactorComplete: true,
  };

  saveSession(updatedSession);
  console.log('[Auth] 2FA verified');

  return { success: true };
}

/**
 * Setup auth IPC handlers
 */
export function setupAuthHandlers(mainWindow: BrowserWindow | null): void {
  // Login
  ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN, async (_, { email, password }) => {
    return handleLogin(email, password);
  });

  // Logout
  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async () => {
    await handleLogout();
    return { success: true };
  });

  // Get auth status
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_STATUS, () => {
    return getAuthStatus();
  });

  // Refresh token
  ipcMain.handle(IPC_CHANNELS.AUTH_REFRESH, async () => {
    return handleRefresh();
  });

  // Send 2FA code
  ipcMain.handle(IPC_CHANNELS.AUTH_SEND_2FA, async (_, { method }) => {
    return handleSend2FA(method);
  });

  // Verify 2FA code
  ipcMain.handle(IPC_CHANNELS.AUTH_VERIFY_2FA, async (_, { code, method }) => {
    return handleVerify2FA(code, method);
  });

  console.log('[Auth] IPC handlers registered');
}

/**
 * Get access token for making authenticated API calls from main process
 * (e.g., for mail push, kanban API calls)
 */
export function getAccessToken(): string | null {
  const session = getStoredSession();
  return session?.accessToken || null;
}

/**
 * Check if we need to refresh the token
 */
export async function ensureValidToken(): Promise<string | null> {
  const session = getStoredSession();
  if (!session) return null;

  // Check if expired or expiring soon (within 5 minutes)
  const expiresAt = new Date(session.expiresAt);
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

  if (expiresAt < fiveMinutesFromNow && session.refreshToken) {
    const result = await handleRefresh();
    if (!result.success) return null;
    return getStoredSession()?.accessToken || null;
  }

  return session.accessToken;
}
