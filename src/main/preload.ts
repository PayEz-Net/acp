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
  PTY_LIST: 'pty:list',
  PTY_SPAWNED: 'pty:spawned',
  PTY_SPAWN_FAILED: 'PTY_SPAWN_FAILED',
  AGENT_SESSION_START_FAILED: 'agent-session:start-failed',
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
  VSQL_CACHE_GET_AUTH_HEADERS: 'vsql-cache:getAuthHeaders',
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
  CLIPBOARD_READ_TEXT: 'clipboard:read-text',
  TRIGGER_PASTE: 'clipboard:trigger-paste',
  // Pre-flight working-dir validation (SPEC-workdir-invalid §3.5).
  WORKDIR_VALIDATE: 'workdir:validate',
    // ACP (Agent Client Protocol) transport.
  ACP_EVENT: 'acp:event',
  ACP_PROMPT: 'acp:prompt',
  ACP_CANCEL: 'acp:cancel',
  ACP_SET_MODE: 'acp:set-mode',
  ACP_KILL: 'acp:kill',
  ACP_PERMISSION_RESPONSE: 'acp:permission-response',
  ACP_SEND_MESSAGE: 'acp:send-message',
} as const;

// Type aliases for preload (avoid importing from shared)
type AppSettings = Record<string, unknown>;
type TerminalData = { terminalId: string; data: string };
// Mirrors SpawnFailedPayload in ../shared/types (preload can't import shared).
// Fixed event contract (BAPert WO #84034) for IPC_CHANNELS.PTY_SPAWN_FAILED.
type SpawnFailedPayload = { code: 'WORKDIR_INVALID' | 'RUNTIME_NOT_SET'; agent_name: string; work_dir?: string; project_id?: number; message: string };
type AuthStatus = { isAuthenticated: boolean; user: unknown; requires2FA: boolean; twoFactorComplete: boolean; expiresAt: string | null };
type LoginRequest = { email: string; password: string };
type LoginResult = { success: boolean; error?: string; requires2FA?: boolean; available2FAMethods?: string[] };
type TwoFactorRequest = { code: string; method: 'email' | 'sms' };
type TwoFactorResult = { success: boolean; error?: string };

// Agent session start failure payload (mirrors ../shared/types).
type AgentSessionStartFailedPayload = { agentName: string; terminalId: string; status?: number; message: string };

// ACP transport type aliases (mirrors ../shared/acpTypes).
type AcpPromptPayload = { agent: string; sessionId: string; text: string };
type AcpCancelPayload = { agent: string; sessionId: string };
type AcpSetModePayload = { agent: string; sessionId: string; mode: string };
type AcpKillPayload = { agent: string; sessionId: string };
type AcpPermissionResponsePayload = { agent: string; sessionId: string; permissionRequestId: number | string; outcome: string; optionId?: string };
type AcpSendMessagePayload = { agent: string; sessionId: string; content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> };
type AcpEventPayload = { agent: string; sessionId: string; update: unknown };


// Expose protected methods to renderer via contextBridge
contextBridge.exposeInMainWorld('electronAPI', {
  // PTY management. NOTE: the renderer-facing spawnAgent IPC was removed
  // (SPEC-team-runtime §3.3 FLAG 6) — it was the phantom !backendAvailable
  // spawn fallback that guessed runtime from the machine global. Spawns now go
  // through the lifecycle callback / orchestrator (both carry the team runtime).
  writeTerminal: (terminalId: string, data: string): void => {
    ipcRenderer.send(IPC_CHANNELS.PTY_WRITE, terminalId, data);
  },

  resizeTerminal: (terminalId: string, cols: number, rows: number): void => {
    ipcRenderer.send(IPC_CHANNELS.PTY_RESIZE, terminalId, cols, rows);
  },

  killTerminal: (terminalId: string): void => {
    ipcRenderer.send(IPC_CHANNELS.PTY_KILL, terminalId);
  },

  // List live terminals with the provider each was launched with
  // (SPEC-team-runtime §3.2). Backs reconcile-on-switch.
  listTerminals: (): Promise<Array<{ id: string; agentName: string; projectId?: number; provider: 'claude' | 'kimi' | 'codex' }>> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PTY_LIST);
  },

  onTerminalData: (callback: (data: TerminalData) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: TerminalData) => {
      if (!isValidPayload<TerminalData>(data, ['terminalId', 'data'])) {
        console.warn('[preload] Dropping malformed terminal-data payload:', data);
        return;
      }
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.PTY_DATA, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_DATA, handler);
  },

  onAgentSpawned: (callback: (data: { agentName: string; terminalId: string; provider?: string }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { agentName: string; terminalId: string; provider?: string }) => {
      if (!isValidPayload<{ agentName: string; terminalId: string }>(data, ['agentName', 'terminalId'])) {
        console.warn('[preload] Dropping malformed agent-spawned payload:', data);
        return;
      }
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.PTY_SPAWNED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_SPAWNED, handler);
  },

  onTerminalExit: (callback: (data: { terminalId: string; exitCode: number }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { terminalId: string; exitCode: number }) => {
      if (!isValidPayload<{ terminalId: string; exitCode: number }>(data, ['terminalId', 'exitCode'])) {
        console.warn('[preload] Dropping malformed terminal-exit payload:', data);
        return;
      }
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.PTY_EXIT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_EXIT, handler);
  },

  // Main → renderer: a spawn failed with a typed cause (WORKDIR_INVALID).
  // Carries the orchestrator-path failure to the renderer surface
  // (SPEC-workdir-invalid §3.4). Returns an unsubscribe fn.
  onPtySpawnFailed: (callback: (payload: SpawnFailedPayload) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, payload: SpawnFailedPayload) => {
      if (!isValidPayload<SpawnFailedPayload>(payload, ['code', 'agent_name', 'message'])) {
        console.warn('[preload] Dropping malformed spawn-failed payload:', payload);
        return;
      }
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.PTY_SPAWN_FAILED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_SPAWN_FAILED, handler);
  },

  onAgentSessionStartFailed: (callback: (payload: AgentSessionStartFailedPayload) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, payload: AgentSessionStartFailedPayload) => {
      if (!isValidPayload<AgentSessionStartFailedPayload>(payload, ['agentName', 'terminalId', 'message'])) {
        console.warn('[preload] Dropping malformed agent-session-start-failed payload:', payload);
        return;
      }
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.AGENT_SESSION_START_FAILED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_SESSION_START_FAILED, handler);
  },

  // Settings
  getSettings: (): Promise<AppSettings> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET);
  },

  // Cloud endpoints — the renderer resolves nothing; it consumes exactly what
  // the main-process env authority (env.ts, baked by gen-env.cjs) decided. The
  // snapshot also carries the env identity for the read-only env indicator (#292).
  getCloudEndpoints: (): Promise<{ vibeApiUrl: string; hubUrl: string; idpUrl: string; envName: string; isPackaged: boolean; isInternalDevBuild: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLOUD_ENDPOINTS);
  },

  // Re-read current-project + lifecycle and feed the orchestrator. Used
  // by the picker Start button (project already RUNNING cloud-side).
  reseedLifecycle: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LIFECYCLE_RESEED);
  },

  // Pre-flight working-dir check (SPEC-workdir-invalid §3.5). Returns whether
  // `path` resolves to a real directory on THIS machine (reuses main's
  // resolveWorkDir authority). The project-open gate calls this before any
  // spawn; the inline correction surface re-runs it before persisting.
  validateWorkDir: (path: string): Promise<{ ok: boolean; resolved: string | null }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKDIR_VALIDATE, path);
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
    const handler = (_: Electron.IpcRendererEvent, data: { error: string }) => {
      if (!isValidPayload<{ error: string }>(data, ['error'])) {
        console.warn('[preload] Dropping malformed auth-session-dead payload:', data);
        return;
      }
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.AUTH_SESSION_DEAD, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AUTH_SESSION_DEAD, handler);
  },

  // OAuth
  openOAuthUrl: (url: string): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OAUTH_OPEN_URL, url);
  },

  onOAuthCallback: (callback: (data: { success: boolean; code?: string; state?: string; error?: { code: string; message: string } }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { success: boolean; code?: string; state?: string; error?: { code: string; message: string } }) => {
      if (!isValidPayload<{ success: boolean }>(data, ['success'])) {
        console.warn('[preload] Dropping malformed OAuth callback payload:', data);
        return;
      }
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.OAUTH_CALLBACK, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.OAUTH_CALLBACK, handler);
  },

  openExternal: (url: string): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url);
  },

  // Read OS clipboard text from main (renderer's navigator.clipboard.readText
  // is permission-denied in the packaged build). Backs terminal paste.
  readClipboardText: (): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_READ_TEXT);
  },

  // Trigger the native paste editing command on the focused element.
  triggerPaste: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_PASTE);
  },

  // ACP transport (Agent Client Protocol) for Kimi and future structured providers.
  sendAcpPrompt: (payload: AcpPromptPayload): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ACP_PROMPT, payload);
  },

  sendAcpCancel: (payload: AcpCancelPayload): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ACP_CANCEL, payload);
  },

  sendAcpSetMode: (payload: AcpSetModePayload): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ACP_SET_MODE, payload);
  },

  sendAcpKill: (payload: AcpKillPayload): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ACP_KILL, payload);
  },

  sendAcpPermissionResponse: (payload: AcpPermissionResponsePayload): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ACP_PERMISSION_RESPONSE, payload);
  },

  sendAcpMessage: (payload: AcpSendMessagePayload): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ACP_SEND_MESSAGE, payload);
  },

  onAcpEvent: (callback: (payload: AcpEventPayload) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, payload: AcpEventPayload) => {
      if (!isValidPayload<AcpEventPayload>(payload, ['agent', 'sessionId', 'update'])) {
        console.warn('[preload] Dropping malformed ACP event payload:', payload);
        return;
      }
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.ACP_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ACP_EVENT, handler);
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

  getVsqlCacheAuthHeaders: (method: string, path: string): Promise<Record<string, string | boolean>> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VSQL_CACHE_GET_AUTH_HEADERS, method, path);
  },

  onBackendStatusChanged: (callback: (data: { available: boolean; message?: string }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { available: boolean; message?: string }) => {
      if (!isValidPayload<{ available: boolean }>(data, ['available'])) {
        console.warn('[preload] Dropping malformed backend-status payload:', data);
        return;
      }
      callback(data);
    };
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
    const handler = (_: Electron.IpcRendererEvent, data: { phase: 'cloud-pending' | 'restarting' | 'error'; targetProjectId: number; errorCode?: string; errorMessage?: string }) => {
      if (!isValidPayload<{ phase: string; targetProjectId: number }>(data, ['phase', 'targetProjectId'])) {
        console.warn('[preload] Dropping malformed project-switch-progress payload:', data);
        return;
      }
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.PROJECT_SWITCH_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PROJECT_SWITCH_PROGRESS, handler);
  },

  // Wave C lifecycle event subscribers (main → renderer broadcasts).
  // Renderer can render a state-of-the-fleet pill, current-project
  // change banner, cloud-unreachable warning, etc.
  onLifecycleProjectChanged: (callback: (data: { oldId: number | null; newId: number | null }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { oldId: number | null; newId: number | null }) => {
      if (!isValidPayload<{ oldId: unknown; newId: unknown }>(data, ['oldId', 'newId'])) {
        console.warn('[preload] Dropping malformed lifecycle-project-changed payload:', data);
        return;
      }
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.LIFECYCLE_PROJECT_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.LIFECYCLE_PROJECT_CHANGED, handler);
  },
  onLifecycleStateChanged: (callback: (data: { projectId: number; oldState: string | null; newState: string | null }) => void): () => void => {
    const handler = (_: Electron.IpcRendererEvent, data: { projectId: number; oldState: string | null; newState: string | null }) => {
      if (!isValidPayload<{ projectId: number; oldState: unknown; newState: unknown }>(data, ['projectId', 'oldState', 'newState'])) {
        console.warn('[preload] Dropping malformed lifecycle-state-changed payload:', data);
        return;
      }
      callback(data);
    };
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

/** Validate a forwarded IPC payload is a non-null object with the expected keys.
 *  Prevents renderer-side dereference crashes (e.g. Cannot read properties of
 *  undefined (reading 'type')) when main or the sandbox bridge emits a malformed
 *  or empty message. */
function isValidPayload<T extends Record<string, unknown>>(
  payload: unknown,
  requiredKeys: (keyof T)[],
): payload is T {
  if (!payload || typeof payload !== 'object') return false;
  return requiredKeys.every((key) => key in payload);
}

// Type declaration for renderer
declare global {
  interface Window {
    electronAPI: {
      writeTerminal: (terminalId: string, data: string) => void;
      resizeTerminal: (terminalId: string, cols: number, rows: number) => void;
      killTerminal: (terminalId: string) => void;
      listTerminals: () => Promise<Array<{ id: string; agentName: string; projectId?: number; provider: 'claude' | 'kimi' | 'codex' }>>;
      onTerminalData: (callback: (data: TerminalData) => void) => () => void;
      onAgentSpawned: (callback: (data: { agentName: string; terminalId: string; provider?: string }) => void) => () => void;
      onTerminalExit: (callback: (data: { terminalId: string; exitCode: number }) => void) => () => void;
      onPtySpawnFailed: (callback: (payload: SpawnFailedPayload) => void) => () => void;
      onAgentSessionStartFailed: (callback: (payload: AgentSessionStartFailedPayload) => void) => () => void;
      getSettings: () => Promise<AppSettings>;
      getCloudEndpoints: () => Promise<{ vibeApiUrl: string; hubUrl: string; idpUrl: string }>;
      reseedLifecycle: () => Promise<void>;
      validateWorkDir: (path: string) => Promise<{ ok: boolean; resolved: string | null }>;
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
      readClipboardText: () => Promise<string>;
      triggerPaste: () => Promise<void>;
      // ACP transport (Agent Client Protocol) for Kimi and future structured providers.
      sendAcpPrompt: (payload: AcpPromptPayload) => Promise<void>;
      sendAcpCancel: (payload: AcpCancelPayload) => Promise<void>;
      sendAcpSetMode: (payload: AcpSetModePayload) => Promise<void>;
      sendAcpKill: (payload: AcpKillPayload) => Promise<void>;
      sendAcpPermissionResponse: (payload: AcpPermissionResponsePayload) => Promise<void>;
      sendAcpMessage: (payload: AcpSendMessagePayload) => Promise<void>;
      onAcpEvent: (callback: (payload: AcpEventPayload) => void) => () => void;
      // ACP backend
      getBackendStatus: () => Promise<{ available: boolean }>;
      getLocalSecret: () => Promise<string | null>;
      retryBackend: () => Promise<{ available: boolean }>;
      getApiLogs: () => Promise<string[]>;
      getVsqlCacheAuthHeaders: (method: string, path: string) => Promise<Record<string, string | boolean>>;
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
