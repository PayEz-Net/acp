"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SETTINGS = exports.IPC_CHANNELS = void 0;
// IPC channel names
exports.IPC_CHANNELS = {
    // PTY management
    PTY_SPAWN: 'pty:spawn',
    PTY_WRITE: 'pty:write',
    PTY_RESIZE: 'pty:resize',
    PTY_KILL: 'pty:kill',
    PTY_DATA: 'pty:data',
    PTY_EXIT: 'pty:exit',
    // Settings
    SETTINGS_GET: 'settings:get',
    SETTINGS_SET: 'settings:set',
    // Window
    WINDOW_MINIMIZE: 'window:minimize',
    WINDOW_MAXIMIZE: 'window:maximize',
    WINDOW_CLOSE: 'window:close',
};
// Default settings
exports.DEFAULT_SETTINGS = {
    layout: 'grid',
    focusAgent: 'BAPert',
    agents: [
        { id: '1', name: 'BAPert', displayName: 'BAPert', workDir: 'E:\\Repos', autoStart: true, position: 'top-right', color: '#7c3aed' },
        { id: '2', name: 'DotNetPert', displayName: 'DotNetPert', workDir: 'E:\\Repos', autoStart: true, position: 'bottom-left', color: '#06b6d4' },
        { id: '3', name: 'NextPert', displayName: 'NextPert', workDir: 'E:\\Repos', autoStart: true, position: 'top-left', color: '#10b981' },
        { id: '4', name: 'QAPert', displayName: 'QAPert', workDir: 'E:\\Repos', autoStart: true, position: 'bottom-right', color: '#f59e0b' },
    ],
    mailPollInterval: 10000,
    theme: 'dark',
    windowBounds: { x: 100, y: 100, width: 1600, height: 900 },
    sidebarWidth: 280,
    showSidebar: true,
};
