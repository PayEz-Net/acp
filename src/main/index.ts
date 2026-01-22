import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import { setupPtyHandlers, killAllPty } from './pty';
import { getSettings, setSettings } from './store';
import { setupAuthHandlers } from './auth';
import { startOAuthServer, stopOAuthServer } from './oauth-server';
import { IPC_CHANNELS } from '../shared/types';

let mainWindow: BrowserWindow | null = null;

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
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:40010');
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

  // Auth handlers (main process handles IDP calls + token storage)
  setupAuthHandlers(mainWindow);

  // OAuth handler - open URL in system browser
  ipcMain.handle(IPC_CHANNELS.OAUTH_OPEN_URL, (_, url: string) => {
    console.log('[OAuth] Opening URL in browser');
    shell.openExternal(url);
  });

  // Start OAuth callback server
  if (mainWindow) {
    startOAuthServer(mainWindow);
  }

  // PTY handlers
  setupPtyHandlers(mainWindow);
}

// App lifecycle
app.whenReady().then(() => {
  setupIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  killAllPty();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killAllPty();
  stopOAuthServer();
});
