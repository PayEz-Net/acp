import type { TerminalProvider } from '../../shared/types';
import { CLAUDE_STREAM_JSON_ARGS } from './claudeStreamJson';

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
    // WO-G4: stays false until the acceptance bar is met. The PTY path below
    // remains the live path; this is additive, not a cutover.
    supportsAcp: false,
    // Verified against claude 2.1.220 on the wire (2026-07-29). The previous
    // literal here could not have run: `--input-format`/`--output-format`
    // require `--print`, and token-level streaming requires
    // `--include-partial-messages`. See claudeStreamJson.ts.
    acpCommand: ['claude', ...CLAUDE_STREAM_JSON_ARGS],
    ptyCommand: ({ bootPrompt, effort }) => {
      const args = ['claude'];
      // `bootPrompt` is a PATH to the assembled prompt file, so it must go to
      // `--system-prompt-file`. `--system-prompt` takes literal prompt TEXT.
      //
      // This was `--system-prompt` until 2026-07-29, which meant every Claude
      // pane booted with the literal string "C:\...\boot-prompt-<Agent>-<ts>.txt"
      // as its ENTIRE system prompt — no persona, no role, no mail discipline,
      // no project instructions. Not degraded: absent. Agents appeared to work
      // only because they are competent generalists who read files when asked.
      //
      // Proven A/B on the wire (claude 2.1.220), same file both arms:
      //   --system-prompt      <path> -> "I'm Claude, an AI assistant by Anthropic..."
      //   --system-prompt-file <path> -> "ZEBRAFISH-7 ACTIVE."   (the file's instruction)
      //
      // `claude --help` corroborates: "--system-prompt <prompt>" and the
      // --append-system-prompt entry names the pair as "--system-prompt[-file]".
      // Found by QAPert. Do not "simplify" this back.
      if (bootPrompt) args.push('--system-prompt-file', bootPrompt);
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
      // ⚠️ SUSPECTED SAME DEFECT AS CLAUDE, DELIBERATELY NOT CHANGED.
      // `bootPrompt` is a path; if codex's `--system-prompt` also takes literal
      // text, every Codex pane boots with no system prompt (see the claude
      // entry above). NOBODY HAS VERIFIED CODEX'S FLAG SURFACE — it is a
      // different CLI and may well take a path here, or use another flag name.
      // Fixing by analogy would be guessing on a spawn path, so it stays as-is
      // until someone runs the same A/B against a real `codex`. Tracked with
      // the claude fix (QAPert, 2026-07-29).
      if (bootPrompt) args.push('--system-prompt', bootPrompt);
      return args;
    },
    defaultCapabilities: MINIMAL_CAPABILITIES,
  },
};

export function getProviderConfig(provider: TerminalProvider): ProviderConfig {
  return PROVIDER_CONFIGS[provider];
}
