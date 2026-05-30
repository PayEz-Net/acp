/**
 * Auth Module for Main Process
 *
 * Auth is managed by ACP API (the communications hub).
 * Electron just mirrors status from ACP API.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import { IPC_CHANNELS, AuthStatus, AuthUser, LoginResult, TwoFactorResult } from '../shared/types';
import { acpApiLogin, acpApiLogout, acpApiRefresh, acpApiGetStatus, acpApiSetExternalSession } from './acp-api-client';

// ---------------------------------------------------------------------------
// Auth event bus — boot-order signal for downstream consumers (lifecycle-hub,
// any future module that needs to wait for a usable IDP access token).
//
// Emits:
//   'session-persisted'  → after AUTH_SET_EXTERNAL_SESSION succeeds OR after
//                          login completes. Listeners should treat this as
//                          "an access token is now available; safe to make
//                          authenticated calls."
//   'session-cleared'    → after logout completes. Listeners should tear
//                          down anything that depends on the IDP token.
//
// Why: per BAPert msg post-1174 — startLifecycleHub previously fired at
// app.whenReady, BEFORE OAuth callback persisted the external session.
// getAccessToken() returned null → buildConnection threw → SignalR
// auto-reconnect never engaged (it only retries AFTER a successful initial
// connect). This event is the canonical "auth is ready" signal that
// downstream consumers gate on instead of guessing at app boot.
// ---------------------------------------------------------------------------
const authEvents = new EventEmitter();
authEvents.setMaxListeners(20);

export type AuthEvent = 'session-persisted' | 'session-cleared';

export function onAuth(event: AuthEvent, listener: () => void): () => void {
  authEvents.on(event, listener);
  return () => authEvents.off(event, listener);
}

/**
 * Get auth status from ACP API
 */
async function getAuthStatus(): Promise<AuthStatus> {
  const result = await acpApiGetStatus();
  
  if (!result.success || !result.data?.is_authenticated) {
    return {
      isAuthenticated: false,
      user: null,
      requires2FA: false,
      twoFactorComplete: false,
      expiresAt: null,
    };
  }

  const user = result.data.user;
  
  return {
    isAuthenticated: true,
    user: user ? {
      id: user.user_id,
      email: user.email,
      name: '',
      roles: [],
    } : null,
    requires2FA: false,
    twoFactorComplete: true,
    expiresAt: result.data.expires_at || null,
  };
}

/**
 * Handle login request
 */
async function handleLogin(email: string, password: string): Promise<LoginResult> {
  const result = await acpApiLogin(email, password);

  if (!result.success || !result.result) {
    return {
      success: false,
      error: result.error?.message || 'Login failed',
    };
  }

  console.log('[Auth] Login successful via ACP API');
  authEvents.emit('session-persisted');

  return {
    success: true,
    requires2FA: false,
  };
}

/**
 * Handle logout request
 */
async function handleLogout(): Promise<void> {
  await acpApiLogout();
  console.log('[Auth] Logged out');
  authEvents.emit('session-cleared');
}

/**
 * Handle token refresh
 */
async function handleRefresh(): Promise<{ success: boolean; error?: string }> {
  const result = await acpApiRefresh();
  if (!result.success) {
    return { success: false, error: result.error || 'Token refresh failed' };
  }
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
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_STATUS, async () => {
    return getAuthStatus();
  });

  // Refresh token
  ipcMain.handle(IPC_CHANNELS.AUTH_REFRESH, async () => {
    return handleRefresh();
  });

  // Send 2FA - not implemented (desktop dev mode uses impersonate)
  ipcMain.handle(IPC_CHANNELS.AUTH_SEND_2FA, async () => {
    return { success: true };
  });

  // Verify 2FA - not implemented
  ipcMain.handle(IPC_CHANNELS.AUTH_VERIFY_2FA, async () => {
    return { success: true };
  });

  // Persist a session built from a renderer-side OAuth flow
  ipcMain.handle(IPC_CHANNELS.AUTH_SET_EXTERNAL_SESSION, async (_, payload) => {
    const result = await acpApiSetExternalSession(payload);
    if (!result.success) {
      console.error('[Auth] External session set failed:', result.error);
      return { success: false, error: result.error?.message || 'External session set failed' };
    }
    console.log('[Auth] External session persisted in acp-api');
    authEvents.emit('session-persisted');
    return { success: true };
  });

  console.log('[Auth] IPC handlers registered (ACP API mode)');
}

let tokenRefreshTimer: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;
const MAX_REFRESH_FAILURES = 5;
const BASE_REFRESH_INTERVAL_MS = 50 * 60 * 1000;
const MAX_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

function nextRefreshInterval(): number {
  if (consecutiveFailures === 0) return BASE_REFRESH_INTERVAL_MS;
  const backoff = BASE_REFRESH_INTERVAL_MS * Math.pow(2, consecutiveFailures - 1);
  return Math.min(backoff, MAX_REFRESH_INTERVAL_MS);
}

/**
 * Start background token refresh
 */
export function startTokenRefreshTimer(): void {
  if (tokenRefreshTimer) {
    clearTimeout(tokenRefreshTimer);
    tokenRefreshTimer = null;
  }
  consecutiveFailures = 0;

  const schedule = () => {
    const interval = nextRefreshInterval();
    tokenRefreshTimer = setTimeout(async () => {
      // Always attempt refresh if the app is running — the refresh token
      // may be valid even when getAuthStatus() reports isAuthenticated=false
      // (access token expired but refresh token still good). Let handleRefresh()
      // sort out whether a token is actually available.
      console.log(`[Auth] Background token refresh triggered at ${new Date().toLocaleTimeString()}`);
      const result = await handleRefresh();

      if (!result.success) {
        consecutiveFailures++;
        console.error(`[Auth] Background refresh failed (${consecutiveFailures}/${MAX_REFRESH_FAILURES}):`, result.error);

        if (consecutiveFailures >= MAX_REFRESH_FAILURES) {
          console.error(`[Auth] Background refresh halted at ${new Date().toLocaleTimeString()} — max failures reached. User must re-authenticate.`);
          // Notify any open renderer windows that the session is dead
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send(IPC_CHANNELS.AUTH_SESSION_DEAD, { error: 'Session expired. Please log in again.' });
            }
          });
          stopTokenRefreshTimer();
          return;
        }
      } else {
        if (consecutiveFailures > 0) {
          console.log(`[Auth] Background refresh recovered at ${new Date().toLocaleTimeString()} after ${consecutiveFailures} failure(s)`);
        }
        consecutiveFailures = 0;
      }

      schedule();
    }, interval);
  };

  schedule();
  console.log('[Auth] Token refresh timer started (50 min base interval)');
}

/**
 * Stop background token refresh
 */
export function stopTokenRefreshTimer(): void {
  if (tokenRefreshTimer) {
    clearTimeout(tokenRefreshTimer);
    tokenRefreshTimer = null;
    consecutiveFailures = 0;
    console.log('[Auth] Token refresh timer stopped');
  }
}

/**
 * Get access token for making authenticated API calls from main process
 */
export async function getAccessToken(): Promise<string | null> {
  // Get token from ACP API
  const { acpApiGetToken } = await import('./acp-api-client');
  return acpApiGetToken();
}

/**
 * Check if we need to refresh the token
 */
export async function ensureValidToken(): Promise<string | null> {
  const result = await handleRefresh();
  if (!result.success) return null;
  
  return getAccessToken();
}
