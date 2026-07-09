import type { TerminalProvider } from '../../shared/types';

export interface ClientCapabilities {
  /** Filesystem capabilities we advertise to the ACP agent. */
  fs: {
    readTextFile: boolean;
    writeTextFile: boolean;
  };
  /** Terminal capability — disabled in Phase 1 so Kimi uses its own tools. */
  terminal: boolean;
}

export interface ProviderConfig {
  id: TerminalProvider;
  displayName: string;
  /** Whether this provider can run in ACP (structured JSON-RPC) mode. */
  supportsAcp: boolean;
  /** Command + args for ACP mode. */
  acpCommand: string[];
  /** Command + args for PTY fallback mode. */
  ptyCommand: (opts: { bootPrompt?: string; effort?: string }) => string[];
  /** Client capabilities advertised during ACP initialize. */
  defaultCapabilities: ClientCapabilities;
  /** Automatically approve permission requests (yolo mode). */
  autoApprove?: boolean;
}

const MINIMAL_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

export const PROVIDER_CONFIGS: Record<TerminalProvider, ProviderConfig> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    supportsAcp: false,
    acpCommand: ['claude', '--output-format', 'stream-json', '--input-format', 'stream-json'],
    ptyCommand: ({ bootPrompt, effort }) => {
      const args = ['claude'];
      if (bootPrompt) args.push('--system-prompt', bootPrompt);
      if (effort) args.push('--effort', effort);
      return args;
    },
    defaultCapabilities: MINIMAL_CAPABILITIES,
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi Code',
    supportsAcp: true,
    acpCommand: ['kimi', '--yolo', 'acp'],
    ptyCommand: ({ bootPrompt }) => {
      const args = ['kimi', '--yolo'];
      // Kimi does not yet support --system-prompt; PTY-inject after banner if needed.
      void bootPrompt;
      return args;
    },
    defaultCapabilities: MINIMAL_CAPABILITIES,
    autoApprove: true,
  },
  codex: {
    id: 'codex',
    displayName: 'Codex CLI',
    supportsAcp: false,
    acpCommand: ['codex', 'app-server'],
    ptyCommand: ({ bootPrompt }) => {
      const args = ['codex'];
      if (bootPrompt) args.push('--system-prompt', bootPrompt);
      return args;
    },
    defaultCapabilities: MINIMAL_CAPABILITIES,
  },
};

export function getProviderConfig(provider: TerminalProvider): ProviderConfig {
  return PROVIDER_CONFIGS[provider];
}
