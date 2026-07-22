import type { TerminalProvider } from '../../shared/types';

/**
 * Per-agent kimi model selection (WO-KIMI-MODEL-OVERRIDE, Jon-locked).
 * The DB stores the BARE model id; the `kimi-code/` prefix is a local
 * config artifact added only at spawn. `null`/undefined override means
 * inherit `default_model` from ~/.kimi-code/config.toml (byte-identical
 * legacy behavior).
 */
export const KIMI_MODEL_ALIASES: Readonly<Record<string, string>> = {
  k3: 'kimi-code/k3',
  'kimi-for-coding': 'kimi-code/kimi-for-coding',
  'kimi-for-coding-highspeed': 'kimi-code/kimi-for-coding-highspeed',
};

/**
 * Thrown when a spawn arrives with a model id outside
 * {@link KIMI_MODEL_ALIASES}. Loud by contract: the highspeed id silently
 * falls back to standard at the runtime with no error — that failure mode
 * is explicitly unacceptable, so a mistyped/unknown id must stop the spawn
 * instead of ever launching the wrong model.
 */
export class ModelNotRecognizedError extends Error {
  constructor(public readonly modelId: string) {
    super(
      `Cannot spawn: '${modelId}' is not a recognized kimi model ` +
      `(known: ${Object.keys(KIMI_MODEL_ALIASES).join(', ')}). ` +
      `Refusing to spawn with a silent model fallback.`,
    );
    this.name = 'ModelNotRecognizedError';
  }
}

/** Bare model id → spawn alias (`kimi-code/<id>`); throws on unknown ids. */
export function resolveKimiModelAlias(modelId: string): string {
  const alias = KIMI_MODEL_ALIASES[modelId];
  if (!alias) throw new ModelNotRecognizedError(modelId);
  return alias;
}

/**
 * Model-aware kimi spawn args. No override → the base args verbatim
 * (byte-identical legacy spawn). With an override → `-m <alias>` inserted
 * before the `acp` subcommand (global flag position), validated loud.
 */
export function kimiSpawnArgs(baseArgs: string[], modelOverride?: string | null): string[] {
  if (!modelOverride) return baseArgs;
  const alias = resolveKimiModelAlias(modelOverride);
  const args = [...baseArgs];
  const acpIndex = args.indexOf('acp');
  if (acpIndex >= 0) {
    args.splice(acpIndex, 0, '-m', alias);
  } else {
    args.push('-m', alias);
  }
  return args;
}

/** k3 thinking efforts (reasoning_effort low/high/max per the model docs). */
const K3_THINKING_EFFORTS: ReadonlySet<string> = new Set(['low', 'high', 'max']);

/**
 * Env value for KIMI_MODEL_THINKING_EFFORT, or undefined when no injection
 * should happen: the effort channel is k3-only, and only when k3 is
 * explicitly selected via override (an inherited default_model might not be
 * k3 — injecting blind would risk mis-applying effort to another model).
 * A set-but-invalid effort for k3 warns and skips (never silently spawns
 * with a wrong value).
 */
export function kimiK3ThinkingEffortEnv(
  modelOverride: string | null | undefined,
  effort: string | undefined,
  onWarn: (message: string) => void,
): string | undefined {
  if (modelOverride !== 'k3' || !effort) return undefined;
  if (K3_THINKING_EFFORTS.has(effort)) return effort;
  onWarn(`effort_override '${effort}' is not a k3 thinking effort (low|high|max) — ignoring`);
  return undefined;
}

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
