import { contextBridge, ipcRenderer } from 'electron';

// Inline IPC channel constants — preload sandbox can't resolve
// ../shared/types so they're duplicated here. MUST stay in sync with
// src/shared/types.ts IPC_CHANNELS. Adding a channel? Add it BOTH
// places. tsc-p tsconfig.main.json catches drift in preload references;
// run that before claiming a Wave-anything ship complete
// (QAPert relay 2026-05-12 — build break caught at cold-launch time).
const IPC_CHANNELS = {
  PTY_SPAWN: 'pty:spawn',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
  PTY_SPAWNED: 'pty:spawned',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  CLOUD_ENDPOINTS: 'cloud:endpoints',
  LIFECYCLE_RESEED: 'lifecycle:reseed',
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_REFRESH: 'auth:refresh',
  AUTH_GET_STATUS: 'auth:getStatus',
  AUTH_SEND_2FA: 'auth:send2fa',
  AUTH_VERIFY_2FA: 'auth:verify2fa',
  AUTH_SET_EXTERNAL_SESSION: 'auth:setExternalSession',
  AUTH_SESSION_DEAD: 'auth:sessionDead',
  OAUTH_OPEN_URL: 'oauth:openUrl',
  OAUTH_CALLBACK: 'oauth:callback',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  ACP_GET_BACKEND_STATUS: 'acp:getBackendStatus',
  ACP_GET_LOCAL_SECRET: 'acp:getLocalSecret',
  ACP_RETRY_BACKEND: 'acp:retryBackend',
  ACP_GET_LOGS: 'acp:getLogs',
  ACP_BACKEND_STATUS_CHANGED: 'acp:backendStatusChanged',
  ACP_RELAUNCH: 'acp:relaunch',
  // Wave C/2 (msg 1155 + 1156)
  PROJECT_SWITCH: 'project:switch',
  PROJECT_SWITCH_PROGRESS: 'project:switchProgress',
  LIFECYCLE_PROJECT_CHANGED: 'lifecycle:project-changed',
  LIFECYCLE_STATE_CHANGED: 'lifecycle:state-changed',
  LIFECYCLE_CLOUD_UNREACHABLE: 'lifecycle:cloud-unreachable',
  LIFECYCLE_CLOUD_RECOVERED: 'lifecycle:cloud-recovered',
  BOOT_GET_NEXT_OVERLAY: 'boot:getNextOverlay',
  BOOT_CLEAR_NEXT_OVERLAY: 'boot:clearNextOverlay',
  OPEN_EXTERNAL: 'shell:openExternal',
} as const;

// Type aliases for preload (avoid importing from shared)
type AppSettings = Record<string, unknown>;
type TerminalData = { terminalId: string; data: string };
type AuthStatus = { isAuthenticated: boolean; user: unknown; requires2FA: boolean; twoFactorComplete: boolean; expiresAt: string | null };
type LoginRequest = { email: string; password: string };
type LoginResult = { success: boolean; error?: string; requires2FA?: boolean; available2FAMethods?: string[] };
type TwoFactorRequest = { code: string; method: 'email' | 'sms' };
type TwoFactorResult = { success: boolean; error?: string };


// Expose protected methods to renderer via contextBridge
contextBridge.exposeInMainWorld('electronAPI', {
  // PTY management
  spawnAgent: (agentName: string, workDir: string, runtime?: 'claude' | 'kimi' | 'codex', projectId?: number, effort?: 'low' | 'medium' | 'high' | 'max'): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PTY_SPAWN, agentName, workDir, runtime, projectId, effort);
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

  onAgentSpawned: (callback: (data: { agentName: string; terminalId: string }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { agentName: string; terminalId: string }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.PTY_SPAWNED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_SPAWNED, handler);
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

  // Cloud endpoints — the renderer resolves nothing; it consumes exactly
  // what the main-process authority (cloud-endpoints.ts) decided.
  getCloudEndpoints: (): Promise<{ vibeApiUrl: string; hubUrl: string; idpUrl: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLOUD_ENDPOINTS);
  },

  // Re-read current-project + lifecycle and feed the orchestrator. Used
  // by the picker Start button (project already RUNNING cloud-side).
  reseedLifecycle: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LIFECYCLE_RESEED);
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

  authSetExternalSession: (payload: {
    accessToken: string;
    refreshToken?: string;
    user: { userId: string; email: string; fullName?: string; roles?: string[] };
  }): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.AUTH_SET_EXTERNAL_SESSION, payload);
  },

  authGetAccessToken: (): Promise<string | null> => {
    return ipcRenderer.invoke('auth:getAccessToken');
  },

  onAuthSessionDead: (callback: (data: { error: string }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { error: string }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AUTH_SESSION_DEAD, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AUTH_SESSION_DEAD, handler);
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

  openExternal: (url: string): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url);
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

  getApiLogs: (): Promise<string[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ACP_GET_LOGS);
  },

  onBackendStatusChanged: (callback: (data: { available: boolean; message?: string }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { available: boolean; message?: string }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.ACP_BACKEND_STATUS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ACP_BACKEND_STATUS_CHANGED, handler);
  },

  // Fire-and-forget: triggers main process to call app.relaunch() + app.exit(0).
  // Used by ProjectPicker switch-stub Restart-ACP affordance (Ship F-bis).
  // Kept for diagnostic / manual relaunch needs; project-switch should use
  // switchProject() below instead (atomic PUT + relaunch).
  relaunchApp: (): void => {
    ipcRenderer.send(IPC_CHANNELS.ACP_RELAUNCH);
  },

  // Wave C project-switch (BAPert msg 1149): atomic PUT current-project +
  // app.relaunch. Main process handles both phases. Renderer should call
  // this when user picks a different project from the portfolio / picker —
  // do NOT mutate any local project state before invoking; the cold boot
  // is the re-instantiation. Returns {success, errorCode?, errorMessage?}
  // synchronously; on success the app restarts within ~250ms.
  switchProject: (targetProjectId: number, targetProjectName: string): Promise<{ success: boolean; errorCode?: string; errorMessage?: string }> => {
    // Both args required. Name drives the boot-overlay copy
    // ("Switching to <project_name>…") painted by the pre-mount HTML
    // script before React loads on the cold boot. Greenfield rule
    // applies: no bare-number form (feedback_no_backward_compat_in_greenfield).
    return ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SWITCH, { targetProjectId, targetProjectName });
  },

  // Wave C/2 Commit D/A — sync read of the next-boot overlay flag,
  // used by the pre-mount HTML script in index.html before React
  // loads. Returns null when no switch is pending (normal cold boot).
  // clearNextBootOverlay() is called by React on mount-complete to
  // keep the overlay one-shot.
  getNextBootOverlay: (): { project_id: number; project_name: string } | null => {
    return ipcRenderer.sendSync(IPC_CHANNELS.BOOT_GET_NEXT_OVERLAY);
  },
  clearNextBootOverlay: (): void => {
    ipcRenderer.sendSync(IPC_CHANNELS.BOOT_CLEAR_NEXT_OVERLAY);
  },
  onProjectSwitchProgress: (callback: (data: { phase: 'cloud-pending' | 'restarting' | 'error'; targetProjectId: number; errorCode?: string; errorMessage?: string }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { phase: 'cloud-pending' | 'restarting' | 'error'; targetProjectId: number; errorCode?: string; errorMessage?: string }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.PROJECT_SWITCH_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PROJECT_SWITCH_PROGRESS, handler);
  },

  // Wave C lifecycle event subscribers (main → renderer broadcasts).
  // Renderer can render a state-of-the-fleet pill, current-project
  // change banner, cloud-unreachable warning, etc.
  onLifecycleProjectChanged: (callback: (data: { oldId: number | null; newId: number | null }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { oldId: number | null; newId: number | null }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.LIFECYCLE_PROJECT_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.LIFECYCLE_PROJECT_CHANGED, handler);
  },
  onLifecycleStateChanged: (callback: (data: { projectId: number; oldState: string | null; newState: string | null }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { projectId: number; oldState: string | null; newState: string | null }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.LIFECYCLE_STATE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.LIFECYCLE_STATE_CHANGED, handler);
  },
  onLifecycleCloudUnreachable: (callback: () => void): () => void => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.LIFECYCLE_CLOUD_UNREACHABLE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.LIFECYCLE_CLOUD_UNREACHABLE, handler);
  },
  onLifecycleCloudRecovered: (callback: () => void): () => void => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.LIFECYCLE_CLOUD_RECOVERED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.LIFECYCLE_CLOUD_RECOVERED, handler);
  },
});

// Type declaration for renderer
declare global {
  interface Window {
    electronAPI: {
      spawnAgent: (agentName: string, workDir: string, runtime?: 'claude' | 'kimi' | 'codex', projectId?: number, effort?: 'low' | 'medium' | 'high' | 'max') => Promise<string>;
      writeTerminal: (terminalId: string, data: string) => void;
      resizeTerminal: (terminalId: string, cols: number, rows: number) => void;
      killTerminal: (terminalId: string) => void;
      onTerminalData: (callback: (data: TerminalData) => void) => () => void;
      onAgentSpawned: (callback: (data: { agentName: string; terminalId: string }) => void) => () => void;
      onTerminalExit: (callback: (data: { terminalId: string; exitCode: number }) => void) => () => void;
      getSettings: () => Promise<AppSettings>;
      getCloudEndpoints: () => Promise<{ vibeApiUrl: string; hubUrl: string; idpUrl: string }>;
      reseedLifecycle: () => Promise<void>;
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
      authSetExternalSession: (payload: {
        accessToken: string;
        refreshToken?: string;
        user: { userId: string; email: string; fullName?: string; roles?: string[] };
      }) => Promise<{ success: boolean; error?: string }>;
      authGetAccessToken: () => Promise<string | null>;
      onAuthSessionDead: (callback: (data: { error: string }) => void) => () => void;
      // OAuth
      openOAuthUrl: (url: string) => Promise<void>;
      onOAuthCallback: (callback: (data: { success: boolean; code?: string; state?: string; error?: { code: string; message: string } }) => void) => () => void;
      // ACP backend
      getBackendStatus: () => Promise<{ available: boolean }>;
      getLocalSecret: () => Promise<string | null>;
      retryBackend: () => Promise<{ available: boolean }>;
      getApiLogs: () => Promise<string[]>;
      onBackendStatusChanged: (callback: (data: { available: boolean; message?: string }) => void) => () => void;
      relaunchApp: () => void;
      // Wave C project-switch + lifecycle event subscribers
      switchProject: (targetProjectId: number, targetProjectName: string) => Promise<{ success: boolean; errorCode?: string; errorMessage?: string }>;
      onProjectSwitchProgress: (callback: (data: { phase: 'cloud-pending' | 'restarting' | 'error'; targetProjectId: number; errorCode?: string; errorMessage?: string }) => void) => () => void;
      // Wave C/2 boot overlay (sync — pre-mount HTML script + React mount-complete)
      getNextBootOverlay: () => { project_id: number; project_name: string } | null;
      clearNextBootOverlay: () => void;
      onLifecycleProjectChanged: (callback: (data: { oldId: number | null; newId: number | null }) => void) => () => void;
      onLifecycleStateChanged: (callback: (data: { projectId: number; oldState: string | null; newState: string | null }) => void) => () => void;
      onLifecycleCloudUnreachable: (callback: () => void) => () => void;
      onLifecycleCloudRecovered: (callback: () => void) => () => void;
    };
  }
}
