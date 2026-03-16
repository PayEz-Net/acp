import { contextBridge, ipcRenderer } from 'electron';

// Inline IPC channel constants — preload sandbox can't resolve ../shared/types
const IPC_CHANNELS = {
  PTY_SPAWN: 'pty:spawn',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_REFRESH: 'auth:refresh',
  AUTH_GET_STATUS: 'auth:getStatus',
  AUTH_SEND_2FA: 'auth:send2fa',
  AUTH_VERIFY_2FA: 'auth:verify2fa',
  OAUTH_OPEN_URL: 'oauth:openUrl',
  OAUTH_CALLBACK: 'oauth:callback',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  VIBE_GET_CREDENTIALS: 'vibe:getCredentials',
  ACP_GET_BACKEND_STATUS: 'acp:getBackendStatus',
  ACP_GET_LOCAL_SECRET: 'acp:getLocalSecret',
  ACP_RETRY_BACKEND: 'acp:retryBackend',
} as const;

// Type aliases for preload (avoid importing from shared)
type AppSettings = Record<string, unknown>;
type TerminalData = { terminalId: string; data: string };
type AuthStatus = { isAuthenticated: boolean; user: unknown; requires2FA: boolean; twoFactorComplete: boolean; expiresAt: string | null };
type LoginRequest = { email: string; password: string };
type LoginResult = { success: boolean; error?: string; requires2FA?: boolean; available2FAMethods?: string[] };
type TwoFactorRequest = { code: string; method: 'email' | 'sms' };
type TwoFactorResult = { success: boolean; error?: string };
type VibeCredentials = { clientId: string; hmacKey: string };

// Expose protected methods to renderer via contextBridge
contextBridge.exposeInMainWorld('electronAPI', {
  // PTY management
  spawnAgent: (agentName: string, workDir: string): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PTY_SPAWN, agentName, workDir);
  },

  writeTerminal: (terminalId: string, data: string): void => {
    ipcRenderer.send(IPC_CHANNELS.PTY_WRITE, terminalId, data);
  },

  resizeTerminal: (terminalId: string, cols: number, rows: number): void => {
    ipcRenderer.send(IPC_CHANNELS.PTY_RESIZE, terminalId, cols, rows);
  },

  killTerminal: (terminalId: string): void => {
    ipcRenderer.send(IPC_CHANNELS.PTY_KILL, terminalId);
  },

  onTerminalData: (callback: (data: TerminalData) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: TerminalData) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.PTY_DATA, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_DATA, handler);
  },

  onTerminalExit: (callback: (data: { terminalId: string; exitCode: number }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { terminalId: string; exitCode: number }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.PTY_EXIT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_EXIT, handler);
  },

  // Settings
  getSettings: (): Promise<AppSettings> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET);
  },

  setSettings: (settings: Partial<AppSettings>): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings);
  },

  // Window controls
  minimizeWindow: (): void => {
    ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE);
  },

  maximizeWindow: (): void => {
    ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE);
  },

  closeWindow: (): void => {
    ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE);
  },

  // Auth (main process handles IDP calls + token storage)
  authLogin: (request: LoginRequest): Promise<LoginResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGIN, request);
  },

  authLogout: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGOUT);
  },

  authGetStatus: (): Promise<AuthStatus> => {
    return ipcRenderer.invoke(IPC_CHANNELS.AUTH_GET_STATUS);
  },

  authRefresh: (): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.AUTH_REFRESH);
  },

  authSend2FA: (method: 'email' | 'sms'): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.AUTH_SEND_2FA, { method });
  },

  authVerify2FA: (request: TwoFactorRequest): Promise<TwoFactorResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.AUTH_VERIFY_2FA, request);
  },

  authGetAccessToken: (): Promise<string | null> => {
    return ipcRenderer.invoke('auth:getAccessToken');
  },

  // OAuth
  openOAuthUrl: (url: string): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OAUTH_OPEN_URL, url);
  },

  onOAuthCallback: (callback: (data: { success: boolean; code?: string; state?: string; error?: { code: string; message: string } }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { success: boolean; code?: string; state?: string; error?: { code: string; message: string } }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.OAUTH_CALLBACK, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.OAUTH_CALLBACK, handler);
  },

  // Vibe credentials (client identity only — HMAC lives in acp-api)
  getVibeCredentials: (): Promise<VibeCredentials> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VIBE_GET_CREDENTIALS);
  },

  // ACP backend
  getBackendStatus: (): Promise<{ available: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ACP_GET_BACKEND_STATUS);
  },

  getLocalSecret: (): Promise<string | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ACP_GET_LOCAL_SECRET);
  },

  retryBackend: (): Promise<{ available: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ACP_RETRY_BACKEND);
  },
});

// Type declaration for renderer
declare global {
  interface Window {
    electronAPI: {
      spawnAgent: (agentName: string, workDir: string) => Promise<string>;
      writeTerminal: (terminalId: string, data: string) => void;
      resizeTerminal: (terminalId: string, cols: number, rows: number) => void;
      killTerminal: (terminalId: string) => void;
      onTerminalData: (callback: (data: TerminalData) => void) => () => void;
      onTerminalExit: (callback: (data: { terminalId: string; exitCode: number }) => void) => () => void;
      getSettings: () => Promise<AppSettings>;
      setSettings: (settings: Partial<AppSettings>) => Promise<boolean>;
      minimizeWindow: () => void;
      maximizeWindow: () => void;
      closeWindow: () => void;
      // Auth (main process handles IDP + tokens)
      authLogin: (request: LoginRequest) => Promise<LoginResult>;
      authLogout: () => Promise<{ success: boolean }>;
      authGetStatus: () => Promise<AuthStatus>;
      authRefresh: () => Promise<{ success: boolean; error?: string }>;
      authSend2FA: (method: 'email' | 'sms') => Promise<{ success: boolean; error?: string }>;
      authVerify2FA: (request: TwoFactorRequest) => Promise<TwoFactorResult>;
      authGetAccessToken: () => Promise<string | null>;
      // OAuth
      openOAuthUrl: (url: string) => Promise<void>;
      onOAuthCallback: (callback: (data: { success: boolean; code?: string; state?: string; error?: { code: string; message: string } }) => void) => () => void;
      // Vibe credentials
      getVibeCredentials: () => Promise<VibeCredentials>;
      // ACP backend
      getBackendStatus: () => Promise<{ available: boolean }>;
      getLocalSecret: () => Promise<string | null>;
      retryBackend: () => Promise<{ available: boolean }>;
    };
  }
}
