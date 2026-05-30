import { app, BrowserWindow, ipcMain, shell, session } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import { setupPtyHandlers, killAllPty } from './pty';
import { getSettings, setSettings } from './store';
import { setupAuthHandlers, startTokenRefreshTimer, stopTokenRefreshTimer, onAuth } from './auth';
import { acpApiGetStatus } from './acp-api-client';
import { startOAuthServer, stopOAuthServer } from './oauth-server';
import { startApiServer, stopApiServer, getLocalSecret, getApiLogs, setOnBackendStatusChange } from './api-server';
import { startLifecycleServer, stopLifecycleServer } from './lifecycle-server';
import { startLifecycleHub, stopLifecycleHub, onLifecycleHubEvent, seedInitialLifecycleState } from './lifecycle-hub';
import { startSpawnOrchestrator, stopSpawnOrchestrator } from './spawn-orchestrator';
import { readAndApplyInstallerHandoff } from './installerHandoff';
import { setupProjectSwitchHandler } from './project-switch';
import { getNextBootOverlay, clearNextBootOverlay } from './store';
import { IPC_CHANNELS } from '../shared/types';
import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '../shared/idp-config';
import { colonizeWorkspace } from './colonize';
import { cloudEndpointsSnapshot } from './cloud-endpoints';

// --- Install-time / headless colonization (NSIS customInstall) -------------
// The installer invokes the just-installed exe headless:
//   ACP.exe --acp-colonize "<root>" --acp-colonize-log "<file>" --agents a,b
// so the workspace is scaffolded AT INSTALL with a file-by-file readout.
// ACP.exe is a Windows GUI-subsystem binary (no console) → its stdout is
// NOT captured by nsExec::ExecToLog, so the readout is written to the
// --acp-colonize-log file which NSIS replays into the installer details
// pane. Same tested colonize engine; resolveRoot is a passthrough (the
// installer already chose+created the folder). Both electron-touching
// seams are overridden, so this runs pre-whenReady, touches NO electron
// API, never deletes, and exits fast. Absent the flag this is a no-op and
// normal app boot continues. Runtime spawn-orchestrator colonize stays as
// an idempotent self-heal backstop (already-satisfied → instant no-op).
{
  const ci = process.argv.indexOf('--acp-colonize');
  if (ci !== -1) {
    const root = process.argv[ci + 1] || '';
    const ai = process.argv.indexOf('--agents');
    const agents = ai !== -1 && process.argv[ai + 1]
      ? process.argv[ai + 1].split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const li = process.argv.indexOf('--acp-colonize-log');
    const logPath = li !== -1 ? (process.argv[li + 1] || '') : '';
    const lines: string[] = [];
    const out = (s: string): void => { lines.push(s); process.stdout.write(s + '\n'); };
    out(`ACP workspace colonization -> ${root}`);
    const res = colonizeWorkspace(
      { repo_path: root, colonizationConsented: true, projectId: 'installer' },
      {
        agents,
        resolveRoot: (p) => (p && String(p).trim() ? String(p) : null),
        noticeSink: (n) => { out(`  ${n}`); },
        onFile: (action, name) => {
          out(`  ${action === 'overwrite' ? 'Overwriting' : 'Inserting'} ${name}`);
        },
      },
    );
    out(`Colonization ${res.status}${res.notice ? ` - ${res.notice}` : ''} (${res.items.length} item(s))`);
    if (logPath) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      try { require('fs').writeFileSync(logPath, lines.join('\r\n') + '\r\n', 'utf8'); }
      catch { /* readout file is best-effort; scaffold still happened */ }
    }
    const ok = res.status === 'colonized' || res.status === 'already-satisfied';
    app.exit(ok ? 0 : 1);
  }
}

let mainWindow: BrowserWindow | null = null;
let backendAvailable = false;
// Set true the moment a quit is initiated (window Close / before-quit).
// Shutdown tears down the sidecar/hub/pty asynchronously; those races
// (killed-child 'error', aborted fetch/SSE rejections) fire AFTER the
// window is gone and, with no handler, trigger Electron's native
// uncaught-exception dialog — the "big ugly scary popup" on close
// (dev + prod). Ctrl+C hard-kills before the teardown can error, which
// is why the terminal path never showed it.
let isQuitting = false;

// Main-process last-resort handlers. Electron shows its default error
// DIALOG only when there is no 'uncaughtException' listener — registering
// these suppresses the popup. Not a swallow-everything hole: errors are
// still logged (visible in terminal / packaged logs). During shutdown
// the app is dying anyway, so exit quietly; otherwise log and keep
// running (a stray async error shouldn't nuke the user's session with a
// modal). Registered before app boot so teardown strays are caught.
process.on('uncaughtException', (err) => {
  console.error('[ACP] uncaughtException:', err);
  if (isQuitting) process.exit(0);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ACP] unhandledRejection:', reason);
  // No dialog, no exit when running — shutdown races are expected noise.
});

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
  const settings = getSettings();
  const { windowBounds } = settings;

  mainWindow = new BrowserWindow({
    x: windowBounds.x,
    y: windowBounds.y,
    width: windowBounds.width,
    height: windowBounds.height,
    minWidth: 800,
    minHeight: 600,
    title: 'ACP',
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // Desktop app — no CORS/same-origin restrictions needed
    },
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:40020');
    // DevTools: Ctrl+Shift+I or F12 to open manually
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Save window bounds on resize/move
  mainWindow.on('resize', saveWindowBounds);
  mainWindow.on('move', saveWindowBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function saveWindowBounds() {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const settings = getSettings();
  setSettings({
    ...settings,
    windowBounds: bounds,
  });
}

// Setup IPC handlers
function setupIpcHandlers() {
  // Settings handlers
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => {
    return getSettings();
  });

  // Cloud-endpoint authority → renderer. Renderer resolves nothing.
  ipcMain.handle(IPC_CHANNELS.CLOUD_ENDPOINTS, () => {
    return cloudEndpointsSnapshot();
  });

  // Picker Start → re-read current-project + lifecycle, emit to the
  // spawn-orchestrator. The project is already RUNNING cloud-side; this
  // just hands the orchestrator the state the backend already has (no
  // cloud mutation, no invented transition).
  ipcMain.handle(IPC_CHANNELS.LIFECYCLE_RESEED, async () => {
    await seedInitialLifecycleState();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_, settings) => {
    setSettings(settings);
    return true;
  });

  // Window handlers
  ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
    mainWindow?.minimize();
  });

  ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, () => {
    mainWindow?.close();
  });

  // Ship F-bis Restart-ACP affordance: renderer hits this when the
  // switchProject fail-loud-stub fires (state=stored, picked-different).
  // Wave C will replace the need entirely by delivering the actual
  // re-instantiation lifecycle.
  ipcMain.on(IPC_CHANNELS.ACP_RELAUNCH, () => {
    app.relaunch();
    app.exit(0);
  });

  // Auth handlers (main process handles IDP calls + token storage)
  setupAuthHandlers(mainWindow);

  // OAuth handler - open URL in system browser
  ipcMain.handle(IPC_CHANNELS.OAUTH_OPEN_URL, (_, url: string) => {
    console.log('[OAuth] Opening URL in browser');
    shell.openExternal(url);
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, (_, url: string) => {
    console.log('[Shell] Opening external URL:', url);
    shell.openExternal(url);
  });

  // Start OAuth callback server
  if (mainWindow) {
    startOAuthServer(mainWindow);
  }

  // PTY handlers
  setupPtyHandlers(mainWindow);

  // Wave C project-switch — atomic PUT current-project + app.relaunch
  // per BAPert msg 1149 (replaces the in-process switch flow Jon
  // flagged as broken in last test).
  setupProjectSwitchHandler(mainWindow);

  // Wave C/2 Commit D/A — sync IPC handlers for the boot overlay.
  // The pre-mount HTML script reads via ipcRenderer.sendSync() and
  // paints the overlay before React loads; React clears the flag on
  // mount-complete to keep the overlay one-shot.
  ipcMain.on(IPC_CHANNELS.BOOT_GET_NEXT_OVERLAY, (event) => {
    event.returnValue = getNextBootOverlay();
  });
  ipcMain.on(IPC_CHANNELS.BOOT_CLEAR_NEXT_OVERLAY, (event) => {
    clearNextBootOverlay();
    event.returnValue = true;
  });

  // ACP backend status + local secret
  ipcMain.handle(IPC_CHANNELS.ACP_GET_BACKEND_STATUS, () => {
    return { available: backendAvailable };
  });

  ipcMain.handle(IPC_CHANNELS.ACP_GET_LOCAL_SECRET, () => {
    return getLocalSecret();
  });

  ipcMain.handle(IPC_CHANNELS.ACP_RETRY_BACKEND, async () => {
    console.log('[ACP] Retrying backend startup...');
    backendAvailable = await startApiServer();
    return { available: backendAvailable };
  });

  // Log viewer support
  ipcMain.handle(IPC_CHANNELS.ACP_GET_LOGS, () => {
    return getApiLogs();
  });

  // Crash recovery: notify renderer when backend status changes
  setOnBackendStatusChange((available, message) => {
    backendAvailable = available;
    mainWindow?.webContents.send(IPC_CHANNELS.ACP_BACKEND_STATUS_CHANGED, { available, message });
  });
}

// App lifecycle
app.whenReady().then(async () => {
  // Start lifecycle callback server first (acp-api needs the port)
  const cbPort = await startLifecycleServer();

  // Start ACP API server and wait for health check
  backendAvailable = await startApiServer();
  
  // Startup summary (quiet mode - agents can query logs via API)
  console.log(`[ACP] Platform ready on port ${cbPort || '?'}`);
  console.log(`[ACP] API: ${backendAvailable ? '✓' : '✗'} | Logs: GET /v1/platform/logs`);

  // Wave C lifecycle poller — runs once backend is confirmed up,
  // talks to acp-api which proxies to cloud. Emits project-changed /
  // state-changed events that Commit B (spawn integration) and
  // Commit C (switch flow) subscribe to. For now (Commit A), events
  // are logged + forwarded to renderer via IPC for visibility.
  if (backendAvailable) {
    // Wave E Stage 7 — lifecycle-hub replaces lifecycle-poller. Push-
    // driven via SignalR /hubs/agentmail (same hub that mail uses).
    // Snapshot-on-connect fires at startup so initial state lands
    // without polling. Spawn-orchestrator subscribes to the hub's
    // project-lifecycle-changed event (same orchestration semantics).
    //
    // Boot-order gate (post BAPert msg post-1174 bug report): wait for
    // the auth `session-persisted` event before calling
    // startLifecycleHub. The previous unconditional call fired at app
    // boot when OAuth callback hadn't yet persisted the external
    // session — getAccessToken returned null → buildConnection threw
    // → SignalR auto-reconnect never engaged. Now we either start
    // immediately (returning user with persisted session) OR wait for
    // the OAuth callback to fire 'session-persisted' before connecting.
    startSpawnOrchestrator();
    onLifecycleHubEvent('project-lifecycle-changed', (...args) => {
      mainWindow?.webContents.send('lifecycle:state-changed', args[0]);
    });
    onLifecycleHubEvent('cloud-unreachable', () => {
      mainWindow?.webContents.send('lifecycle:cloud-unreachable', {});
    });
    onLifecycleHubEvent('cloud-recovered', () => {
      mainWindow?.webContents.send('lifecycle:cloud-recovered', {});
    });

    // Returning-user path: if acp-api already has a persisted session
    // at boot, connect now without waiting for the auth event.
    void (async () => {
      try {
        const status = await acpApiGetStatus();
        if (status.success && status.data?.is_authenticated) {
          console.log('[LifecycleHub] boot: session already persisted, connecting now');
          await startLifecycleHub();
        } else {
          console.log('[LifecycleHub] boot: no session yet, waiting for OAuth callback');
        }
      } catch (err) {
        console.warn('[LifecycleHub] boot: status check failed, will wait for auth event:', err);
      }
    })();

    // First-time-login path: OAuth callback persists the session →
    // auth.ts emits 'session-persisted' → start the hub now.
    onAuth('session-persisted', () => {
      // COL-6 M5.1: first authenticated launch executes the installer's
      // mandate — seed the REAL consent gate + record the installer-
      // decided root from the handoff (installer-spec v2 §5), BEFORE the
      // lifecycle/colonize flow. Best-effort, never throws.
      readAndApplyInstallerHandoff();
      console.log('[LifecycleHub] auth-ready, connecting...');
      void startLifecycleHub();
    });

    // Logout path: tear down the hub so its connection doesn't outlive
    // the session (would 401 on next reconnect anyway, but clean is
    // better than waiting for the close).
    onAuth('session-cleared', () => {
      console.log('[LifecycleHub] session cleared, stopping hub');
      void stopLifecycleHub();
    });
  } else {
    console.warn('[ACP] Lifecycle hub skipped — backend not available; will activate on next boot');
  }

  // Bypass CORS — this is a desktop app, not a browser
  // Must delete server-side CORS headers first to avoid duplicates
  // (Express sends title-case, we set lowercase → two headers → browser rejects)
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    delete details.requestHeaders['Origin'];
    callback({ requestHeaders: details.requestHeaders });
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    // Remove any server-side CORS headers (case-insensitive cleanup)
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith('access-control-')) {
        delete headers[key];
      }
    }
    callback({
      responseHeaders: {
        ...headers,
        'access-control-allow-origin': ['*'],
        'access-control-allow-headers': ['*'],
        'access-control-allow-methods': ['GET, POST, PUT, DELETE, OPTIONS'],
      },
    });
  });

  createWindow();
  setupIpcHandlers();

  // Auto-update check on launch (best-effort; failure does not block boot)
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.warn('[AutoUpdate] Check failed:', err.message);
  });

  // Start background token refresh (will only refresh if user is logged in)
  startTokenRefreshTimer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  isQuitting = true;
  try { stopSpawnOrchestrator(); } catch (e) { console.error('[ACP] stopSpawnOrchestrator:', e); }
  try { void stopLifecycleHub(); } catch (e) { console.error('[ACP] stopLifecycleHub:', e); }
  try { killAllPty(); } catch (e) { console.error('[ACP] killAllPty:', e); }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (e) => {
  isQuitting = true;
  // Graceful quit: signal acp-api shutdown, wait, then clean up
  console.log('[ACP] Graceful quit sequence starting...');

  // Send shutdown signal to acp-api (if running)
  try {
    const secret = getLocalSecret();
    if (secret) {
      await Promise.race([
        fetch('http://127.0.0.1:3001/internal/shutdown', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${secret}`,
            [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
          },
        }).catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 5000)), // 5s max wait
      ]);
    }
  } catch { /* ignore — best effort */ }

  try { killAllPty(); } catch (err) { console.error('[ACP] killAllPty:', err); }
  try { stopApiServer(); } catch (err) { console.error('[ACP] stopApiServer:', err); }
  try { stopLifecycleServer(); } catch (err) { console.error('[ACP] stopLifecycleServer:', err); }
  try { stopOAuthServer(); } catch (err) { console.error('[ACP] stopOAuthServer:', err); }
  try { stopTokenRefreshTimer(); } catch (err) { console.error('[ACP] stopTokenRefreshTimer:', err); }
  console.log('[ACP] Graceful quit complete');
});
