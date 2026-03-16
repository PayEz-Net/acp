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

function getAcpBinDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin');
  }
  // Dev mode: resources/bin relative to repo root
  return path.join(app.getAppPath(), 'resources', 'bin');
}

export function setupPtyHandlers(mainWindow: BrowserWindow | null) {
  // Spawn a new PTY for an agent
  ipcMain.handle(IPC_CHANNELS.PTY_SPAWN, (_, agentName: string, workDir: string) => {
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
      mainWindow?.webContents.send(IPC_CHANNELS.PTY_DATA, { terminalId: id, data });
    });

    ptyProcess.onExit(({ exitCode }) => {
      mainWindow?.webContents.send(IPC_CHANNELS.PTY_EXIT, { terminalId: id, exitCode });
      terminals.delete(id);
    });

    // Auto-inject claude with skip-permissions, then wait for ready prompt
    setTimeout(() => {
      ptyProcess.write('claude --dangerously-skip-permissions\r');

      // Watch PTY output for Claude's ready indicator before sending report command
      let reportSent = false;
      const dataListener = ptyProcess.onData((data) => {
        // Claude Code shows "❯" when ready for input
        if (!reportSent && data.includes('\u276F')) {
          reportSent = true;
          console.log(`[PTY] Claude ready for ${agentName}, sending report command`);
          setTimeout(() => {
            ptyProcess.write(`report as ${agentName}\r`);
          }, 500);
          dataListener.dispose();
        }
      });

      // Fallback: if prompt not detected in 15s, send anyway
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
  });

  // Write to PTY
  ipcMain.on(IPC_CHANNELS.PTY_WRITE, (_, terminalId: string, data: string) => {
    const terminal = terminals.get(terminalId);
    if (terminal) {
      terminal.pty.write(data);
    }
  });

  // Resize PTY
  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_, terminalId: string, cols: number, rows: number) => {
    const terminal = terminals.get(terminalId);
    if (terminal) {
      terminal.pty.resize(cols, rows);
    }
  });

  // Kill PTY
  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_, terminalId: string) => {
    const terminal = terminals.get(terminalId);
    if (terminal) {
      terminal.pty.kill();
      terminals.delete(terminalId);
    }
  });
}

export function killAllPty() {
  terminals.forEach((terminal) => {
    terminal.pty.kill();
  });
  terminals.clear();
}
