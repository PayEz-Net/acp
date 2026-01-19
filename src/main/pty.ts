import { ipcMain, BrowserWindow } from 'electron';
import * as pty from 'node-pty';
import { IPC_CHANNELS } from '../shared/types';

interface ManagedPty {
  id: string;
  agentName: string;
  pty: pty.IPty;
}

const terminals: Map<string, ManagedPty> = new Map();

export function setupPtyHandlers(mainWindow: BrowserWindow | null) {
  // Spawn a new PTY for an agent
  ipcMain.handle(IPC_CHANNELS.PTY_SPAWN, (_, agentName: string, workDir: string) => {
    const id = crypto.randomUUID();
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: {
        ...process.env,
        VIBE_AGENT: agentName,
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

    // Auto-inject claude and report as command
    setTimeout(() => {
      ptyProcess.write('claude\r');
      setTimeout(() => {
        ptyProcess.write(`report as ${agentName}\r`);
      }, 2000);
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
