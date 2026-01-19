import { AppSettings, TerminalData } from '@shared/types';

export {};

declare global {
  interface Window {
    electronAPI: {
      // PTY management
      spawnAgent: (agentName: string, workDir: string) => Promise<string>;
      writeTerminal: (terminalId: string, data: string) => void;
      resizeTerminal: (terminalId: string, cols: number, rows: number) => void;
      killTerminal: (terminalId: string) => void;
      onTerminalData: (callback: (data: TerminalData) => void) => () => void;
      onTerminalExit: (callback: (data: { terminalId: string; code: number }) => void) => () => void;

      // Settings
      getSettings: () => Promise<AppSettings>;
      setSettings: (settings: Partial<AppSettings>) => Promise<void>;

      // Window controls
      minimizeWindow: () => void;
      maximizeWindow: () => void;
      closeWindow: () => void;
    };
  }
}
