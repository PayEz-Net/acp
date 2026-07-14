// Load sibling .env before any module reads process.env. This lets the installed
// app configure secrets without relying on shell env vars.
import './loadEnv';

import { app, BrowserWindow, ipcMain, shell, session, dialog, clipboard } from 'electron';
import { autoUpdater } from 'electron-updater';
import net from 'net';
import { execSync } from 'child_process';
import path from 'path';
import { setupPtyHandlers, killAllPty } from './pty';
import { getSettings, setSettings } from './store';
import { setupAuthHandlers, startTokenRefreshTimer, stopTokenRefreshTimer, onAuth } from './auth';
import { acpApiGetStatus } from './acp-api-client';
import { startOAuthServer, stopOAuthServer, OAUTH_PORT } from './oauth-server';
import { startApiServer, stopApiServer, getLocalSecret, getApiLogs, setOnBackendStatusChange } from './api-server';
import { startLifecycleServer, stopLifecycleServer } from './lifecycle-server';
import { startLifecycleHub, stopLifecycleHub, onLifecycleHubEvent, seedInitialLifecycleState } from './lifecycle-hub';
import { startSpawnOrchestrator, stopSpawnOrchestrator } from './spawn-orchestrator';
import { readAndApplyInstallerHandoff } from './installerHandoff';
import { setupProjectSwitchHandler } from './project-switch';
import { getNextBootOverlay, clearNextBootOverlay } from './store';
import { IPC_CHANNELS } from '../shared/types';
import { colonizeWorkspace } from './colonize';
import { VIBE_API_URL, cloudEndpointsSnapshot } from './env';
import { buildVsqlCacheAuthHeaders } from './vsql-cache-client';
import { getActiveSessionTokenForProject } from './agentSessionLifecycle';

// --- Install-time / headless colonization (NSIS customInstall) -------------
// The installer invokes the just-installed exe headless:
//   ACP.exe --acp-colonize "<root>" --acp-colonize-log "<file>" --agents a,b
// so the workspace is scaffolded AT INSTALL with a file-by-file readout.
// ACP.exe is a Windows GUI-subsystem binary (no console) → its stdout is
// NOT captured by nsExec::ExecToLog, so the readout is written to the
// --acp-colonize-log file which NSIS replays into the installer details
// pane. Same tested colonize engine; resolveRoot is a passthrough (the
// installer already chose+created the folder). Both electron-touching
// seams are overridden, so this runs pre-whenReady and never needs
// app.whenReady/a window — it reads only the ready-immediately
// app.isPackaged/resourcesPath (to locate the bundled skills templates),
// merges rather than deletes, and exits fast. Absent the flag this is a no-op and
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

// --- Single-instance lock (installer OAuth-stall ship-blocker) -------------
// Jon almost always has an ACP already alive holding :40021. A 2nd (freshly
// installed) instance's oauth-server then hit EADDRINUSE and silently retried
// forever; the browser OAuth callback (→ localhost:40021) was answered by the
// OTHER live instance — whose renderer was NOT awaiting a login — so the IPC
// was dropped and the new window's loginWithOAuth awaited a callback that
// never came = infinite spinner. The lock makes a 2nd launch quit and focus
// the 1st, killing the port collision at the source.
//
// Placement: AFTER the headless `--acp-colonize` block above (which
// app.exit()s). That install-time invocation must scaffold the workspace
// regardless of a running GUI instance and must NOT be short-circuited by the
// lock.
//
// NOTE (intended side effect): the dev-folder build and the installed build
// share an app id, so they can no longer run simultaneously — a 2nd launch
// now focuses the 1st instead of starting a rival process.
//
// The actual quit decision (and the friendly "already running" dialog) is
// deferred to whenReady — dialog.showMessageBoxSync is only reliable once the
// app is ready, and we want the message to render pre-window. We still
// register the second-instance focus handler here for the HEALTHY case (1st
// instance alive with a live window).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Friendly "already running" surfacing (Jon's voice, consent-first). Replaces
// the silent lock-quit and the silent OAuth-callback spinner: the user is told
// plainly why nothing new launched. This is the ONLY signal when a ZOMBIE
// leftover holds the port but released the lock (pairs with Scout's teardown
// fix, which removes the orphan; this catches the case where one survives).
function showAlreadyRunningAndQuit(): void {
  try {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'ACP is already running',
      message: 'Looks like ACP is already running',
      detail: "Possibly a leftover from a session that didn't fully close. Shut it down and try again.",
      buttons: ['OK'],
      defaultId: 0,
    });
  } catch (e) {
    console.error('[ACP] already-running dialog failed to show:', e);
  }
  app.quit();
}

// Probe whether something is already LISTENing on the OAuth loopback port.
// A successful connect = the port is held (another ACP or a zombie); refused/
// timeout = free. We probe BEFORE starting our own oauth-server so a positive
// unambiguously means someone ELSE owns it.
function isOAuthPortInUse(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port: OAUTH_PORT, host: '127.0.0.1' });
    let settled = false;
    const finish = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(700);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false)); // ECONNREFUSED = nothing listening
  });
}
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
      // Dev-only: disable CORS/same-origin so the renderer can reach the local
      // Vite dev server (localhost:40020) and the acp-api sidecar. This is
      // intentional for local development and produces console warnings about
      // disabled webSecurity.
      //
      // Risk: renderer can load remote/insecure content. Mitigation: in
      // packaged production builds the renderer loads file:// resources and
      // runs with webSecurity: true. Dev builds intentionally keep it false.
      // allowRunningInsecureContent stays false in all configurations.
      webSecurity: !isDev,
      allowRunningInsecureContent: false,
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

  // Terminal paste reads the OS clipboard here (main) rather than in the
  // renderer: navigator.clipboard.readText() is permission-gated and denied
  // in the packaged app, which is why Ctrl+V silently no-op'd. clipboard.readText()
  // in main is ungated and always returns the current text.
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_READ_TEXT, () => clipboard.readText());

  // Trigger the native paste editing command so the context menu can paste
  // images into the focused composer input exactly like Ctrl+V does.
  ipcMain.handle(IPC_CHANNELS.TRIGGER_PASTE, () => {
    mainWindow?.webContents.paste();
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

  // Agent-output auth/context headers (PayEzVibe API mediated)
  ipcMain.handle(IPC_CHANNELS.VSQL_CACHE_GET_AUTH_HEADERS, async (_, method: string, path: string) => {
    try {
      const headers = await buildVsqlCacheAuthHeaders(method, path);
      // Return the active PayEzVibe API base URL and bearer token. The desktop
      // never holds the backend cache container secret.
      return { url: VIBE_API_URL, ...headers };
    } catch (e) {
      console.error('[vibe-api] agent-output auth headers error:', e);
      return { error: String(e) };
    }
  });

  // Agent-output stream session token: return any active PayEzVibe session
  // token for the requested project so the renderer SSE stream can resolve
  // without relying on agent name/id lookups.
  ipcMain.handle(IPC_CHANNELS.VSQL_CACHE_GET_ACTIVE_SESSION_TOKEN, (_, projectId: number) => {
    try {
      const token = getActiveSessionTokenForProject(projectId);
      return { token: token ?? null };
    } catch (e) {
      console.error('[vibe-api] get active session token error:', e);
      return { error: String(e) };
    }
  });

  // Crash recovery: notify renderer when backend status changes
  setOnBackendStatusChange((available, message) => {
    backendAvailable = available;
    mainWindow?.webContents.send(IPC_CHANNELS.ACP_BACKEND_STATUS_CHANGED, { available, message });
  });
}

// App lifecycle
app.whenReady().then(async () => {
  // Collision check #1 — lock-loser: another instance with our app id is
  // alive. Tell the user plainly, then quit (the 1st instance's
  // second-instance handler focuses its window for the healthy case).
  if (!gotSingleInstanceLock) {
    showAlreadyRunningAndQuit();
    return;
  }

  // Collision check #2 — foreign/zombie the lock misses (different app-id /
  // cross-build, or a zombie that released the lock but still holds the OAuth
  // loopback). Probe :40021 BEFORE starting any server; if held, surface the
  // same friendly dialog and quit rather than EADDRINUSE-looping silently.
  if (await isOAuthPortInUse()) {
    console.warn(`[ACP] Port ${OAUTH_PORT} already LISTENing at startup — another ACP (or a zombie) owns the OAuth loopback. Surfacing dialog and quitting.`);
    showAlreadyRunningAndQuit();
    return;
  }

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
      // #248 (#225b): re-arm the background token-refresh timer on EVERY
      // session-persist, not just the initial whenReady call. After an
      // AUTH_SESSION_DEAD (max refresh failures) the timer is stopped; a
      // re-login fired this event but never restarted it, so the access token
      // expired ~50min later → session-dead again → an hourly forced-re-login
      // loop until app restart. startTokenRefreshTimer() is idempotent (clears
      // any existing timer first), so a double session-persist won't double-arm.
      startTokenRefreshTimer();
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

app.on('before-quit', () => {
  isQuitting = true;
  // SYNCHRONOUS, kill-first teardown (option a). The old handler was `async`
  // with no e.preventDefault(): Electron does NOT await an async before-quit,
  // so the continuation after the `await` (killAllPty/stopApiServer/…) was
  // ABANDONED — main lingered holding :40021 while the single-instance lock
  // was already released = the zombie-holds-port case behind the OAuth
  // collision. The awaited POST /internal/shutdown was also a 404 no-op
  // (acp-api has no such route), so the 5s race wrapped nothing. Everything
  // now runs inline, synchronously.
  //
  // Cloud lifecycle is untouched: RUNNING/STOPPED is driven ONLY by
  // POST /v1/projects/:id/lifecycle, which no shutdown path calls — dropping
  // the /internal/shutdown round-trip changes nothing there (no regression).
  console.log('[ACP] Quit teardown (synchronous, kill-first)...');
  try { stopSpawnOrchestrator(); } catch (err) { console.error('[ACP] stopSpawnOrchestrator:', err); }
  try { void stopLifecycleHub(); } catch (err) { console.error('[ACP] stopLifecycleHub:', err); }
  try { killAllPty(); } catch (err) { console.error('[ACP] killAllPty:', err); }
  try { stopApiServer(); } catch (err) { console.error('[ACP] stopApiServer:', err); }
  try { stopLifecycleServer(); } catch (err) { console.error('[ACP] stopLifecycleServer:', err); }
  try { stopOAuthServer(); } catch (err) { console.error('[ACP] stopOAuthServer:', err); }
  try { stopTokenRefreshTimer(); } catch (err) { console.error('[ACP] stopTokenRefreshTimer:', err); }
  console.log('[ACP] Quit teardown complete');
});

// Belt-and-suspenders: a final synchronous sweep confirming nothing this app
// owns still LISTENs on its ports before the process exits, so port + lock
// release together and the next launch's OAuth binds clean. win32-only
// (taskkill); excludes our own pid (the OAuth/lifecycle servers are in-process
// in main and release on exit — only the acp-api child is a separate pid).
function sweepOwnedPort(port: number): void {
  if (process.platform !== 'win32') return;
  try {
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, {
      encoding: 'utf8', timeout: 4000,
    }).trim();
    const pids = new Set<string>();
    for (const line of out.split('\n')) {
      const m = line.match(/\s(\d+)\s*$/);
      if (m) pids.add(m[1]);
    }
    for (const pid of pids) {
      if (pid === String(process.pid)) continue; // our own in-process servers; already closed
      execSync(`taskkill /PID ${pid} /T /F`, { timeout: 4000, stdio: 'ignore' });
    }
  } catch { /* nothing listening / already gone — fine */ }
}

app.on('will-quit', () => {
  // OAUTH_PORT (40021) + acp-api (3001) + lifecycle callback (40030). Any
  // straggler that survived before-quit gets reaped so the ports free with us.
  sweepOwnedPort(OAUTH_PORT);
  sweepOwnedPort(3001);
  sweepOwnedPort(40030);
});
