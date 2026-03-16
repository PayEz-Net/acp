import { ipcMain, BrowserWindow, app } from 'electron';
import * as pty from 'node-pty';
import * as path from 'path';
import * as crypto from 'crypto';
import { IPC_CHANNELS } from '../shared/types';

interface ManagedPty {
  id: string;
  agentName: string;
  pty: pty.IPty;
}

const terminals: Map<string, ManagedPty> = new Map();
let mainWindowRef: BrowserWindow | null = null;

// Exit callback — set by lifecycle-server to report PTY exits to acp-api
let onPtyExit: ((agentName: string, terminalId: string, exitCode: number) => void) | null = null;

export function setOnPtyExit(callback: typeof onPtyExit) {
  onPtyExit = callback;
}

function getAcpBinDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin');
  }
  return path.join(app.getAppPath(), 'resources', 'bin');
}

/**
 * Spawn a PTY for an agent. Returns the terminal UUID.
 * Called by IPC (renderer) or HTTP (lifecycle-server from acp-api).
 */
export function spawnAgent(agentName: string, workDir: string): string {
  const id = crypto.randomUUID();
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const acpBinDir = getAcpBinDir();
  const existingPath = process.env.PATH || process.env.Path || '';

  console.log(`[PTY] Spawning ${agentName} shell=${shell} cwd=${workDir}`);

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: workDir,
    env: {
      ...process.env,
      VIBE_AGENT: agentName,
      ACP_SURFACE_ID: id,
      ACP_AGENT_ID: `agent:${agentName}`,
      ACP_API_URL: process.env.ACP_API_URL || 'http://localhost:3001',
      ACP_BIN_DIR: acpBinDir,
      PATH: `${acpBinDir}${path.delimiter}${existingPath}`,
    } as Record<string, string>,
  });

  terminals.set(id, { id, agentName, pty: ptyProcess });

  // Forward PTY output to renderer
  ptyProcess.onData((data) => {
    mainWindowRef?.webContents.send(IPC_CHANNELS.PTY_DATA, { terminalId: id, data });
  });

  ptyProcess.onExit(({ exitCode }) => {
    mainWindowRef?.webContents.send(IPC_CHANNELS.PTY_EXIT, { terminalId: id, exitCode });
    terminals.delete(id);
    // Report to acp-api via callback
    if (onPtyExit) {
      onPtyExit(agentName, id, exitCode);
    }
  });

  // Auto-inject claude with skip-permissions, then wait for ready prompt
  setTimeout(() => {
    ptyProcess.write('claude --dangerously-skip-permissions --effort max\r');

    let reportSent = false;
    const dataListener = ptyProcess.onData((data) => {
      if (!reportSent && data.includes('\u276F')) {
        reportSent = true;
        console.log(`[PTY] Claude ready for ${agentName}, sending report command`);
        setTimeout(() => {
          ptyProcess.write(`report as ${agentName}\r`);
        }, 500);
        dataListener.dispose();
      }
    });

    setTimeout(() => {
      if (!reportSent) {
        reportSent = true;
        console.log(`[PTY] Fallback: sending report command for ${agentName}`);
        ptyProcess.write(`report as ${agentName}\r`);
        dataListener.dispose();
      }
    }, 15000);
  }, 500);

  return id;
}

/** Kill a PTY by terminal ID */
export function killTerminal(terminalId: string): boolean {
  const terminal = terminals.get(terminalId);
  if (terminal) {
    terminal.pty.kill();
    terminals.delete(terminalId);
    return true;
  }
  return false;
}

/** Resize a PTY */
export function resizeTerminal(terminalId: string, cols: number, rows: number): boolean {
  const terminal = terminals.get(terminalId);
  if (terminal) {
    terminal.pty.resize(cols, rows);
    return true;
  }
  return false;
}

/** Get terminal info by agent name */
export function getTerminalByAgent(agentName: string): ManagedPty | undefined {
  for (const t of terminals.values()) {
    if (t.agentName === agentName) return t;
  }
  return undefined;
}

/** Get all active terminals */
export function getActiveTerminals(): Array<{ id: string; agentName: string }> {
  return Array.from(terminals.values()).map(t => ({ id: t.id, agentName: t.agentName }));
}

export function setupPtyHandlers(mainWindow: BrowserWindow | null) {
  mainWindowRef = mainWindow;

  ipcMain.handle(IPC_CHANNELS.PTY_SPAWN, (_, agentName: string, workDir: string) => {
    return spawnAgent(agentName, workDir);
  });

  ipcMain.on(IPC_CHANNELS.PTY_WRITE, (_, terminalId: string, data: string) => {
    const terminal = terminals.get(terminalId);
    if (terminal) {
      terminal.pty.write(data);
    }
  });

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_, terminalId: string, cols: number, rows: number) => {
    resizeTerminal(terminalId, cols, rows);
  });

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_, terminalId: string) => {
    killTerminal(terminalId);
  });
}

export function killAllPty() {
  terminals.forEach((terminal) => {
    terminal.pty.kill();
  });
  terminals.clear();
}
