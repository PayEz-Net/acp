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
  'k3-256k': 'kimi-code/k3-256k',
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
  constructor(
    public readonly modelId: string,
    known: string[] = Object.keys(KIMI_MODEL_ALIASES),
    provider = 'kimi',
  ) {
    super(
      `Cannot spawn: '${modelId}' is not a recognized ${provider} model ` +
      `(known: ${known.join(', ')}). ` +
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

/**
 * Claude models the per-agent picker offers, passed verbatim to Claude Code's
 * `--model`. These are Claude Code's tier aliases — it resolves each to the
 * latest model of that tier — so the set is version-proof (no dated ids to
 * churn). `haiku` is the fast/cheap tier (a background agent like NextPert),
 * `opus` the heavyweight; an absent override inherits Claude Code's default.
 */
export const CLAUDE_MODELS: ReadonlySet<string> = new Set(['haiku', 'sonnet', 'opus', 'fable']);

/**
 * Model-aware claude spawn args. No override → [] (default model). A recognized
 * claude model → `--model <alias>`. Anything else — a stale/cross-runtime id
 * like a kimi 'k3' left on a placement that now resolves to claude — is IGNORED
 * and the agent spawns the default model, matching the retired TUI path (which
 * logged "IGNORING model_override … that is a kimi model id"). A mismatched
 * override is stale data, NOT a reason to fail the spawn. (kimi's own -m path
 * still fails loud on unknown kimi ids — there it is a real config error.)
 */
export function claudeModelArgs(
  modelOverride: string | null | undefined,
  onWarn?: (message: string) => void,
): string[] {
  if (!modelOverride) return [];
  if (!CLAUDE_MODELS.has(modelOverride)) {
    onWarn?.(
      `ignoring model_override '${modelOverride}' — not a claude model ` +
      `(${[...CLAUDE_MODELS].join(', ')}); spawning the default model`,
    );
    return [];
  }
  return ['--model', modelOverride];
}

/** k3 thinking efforts (reasoning_effort low/high/max per the model docs). */
const K3_THINKING_EFFORTS: ReadonlySet<string> = new Set(['low', 'high', 'max']);

/** k3-family ids that accept the thinking-effort channel (k3 + its 256k variant). */
const K3_FAMILY_MODELS: ReadonlySet<string> = new Set(['k3', 'k3-256k']);

/**
 * Env value for KIMI_MODEL_THINKING_EFFORT, or undefined when no injection
 * should happen: the effort channel is k3-family-only, and only when a k3-family
 * model is explicitly selected via override (an inherited default_model might not
 * be k3 — injecting blind would risk mis-applying effort to another model).
 * A set-but-invalid effort for k3 warns and skips (never silently spawns
 * with a wrong value).
 */
export function kimiK3ThinkingEffortEnv(
  modelOverride: string | null | undefined,
  effort: string | undefined,
  onWarn: (message: string) => void,
): string | undefined {
  if (!modelOverride || !K3_FAMILY_MODELS.has(modelOverride) || !effort) return undefined;
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
  // NO ptyCommand. It existed here for all three providers with ZERO callers
  // anywhere in src/, while each provider's real PTY invocation is composed as
  // a string in pty.ts. Deleted 2026-07-29 after it misled two work orders in
  // one day and caused a false P0 closure: QAPert's --system-prompt identity
  // fix was applied here, reported done, and changed nothing, because the live
  // spawn was untouched. Claude's live composition now lives in
  // claudeSpawnCommand.ts, which is unit-tested. Do not reintroduce a
  // plausible-looking command builder that nothing calls.
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
    // WO-G4 cutover: claude runs through the ACP runtime via
    // ClaudeStreamJsonProcess, which maps its stream-json output into the same
    // AcpSessionUpdate vocabulary kimi emits. The old PTY/TUI path
    // (claudeSpawnCommand.ts) is retired.
    supportsAcp: true,
    // `-p` structured mode (CLAUDE_STREAM_JSON_ARGS, verified against claude
    // 2.1.220) + skip the interactive permission prompt: the stream-json
    // adapter deliberately does not answer permission control-requests, so
    // tools would block without this. The session id is injected at spawn
    // (--resume / --session-id) by AcpRuntimeManager.
    acpCommand: ['claude', ...CLAUDE_STREAM_JSON_ARGS, '--dangerously-skip-permissions'],
    defaultCapabilities: MINIMAL_CAPABILITIES,
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi Code',
    supportsAcp: true,
    acpCommand: ['kimi', '--yolo', 'acp'],
    // PTY invocation is composed in pty.ts (kimiLaunch). Kimi exposes no
    // --system-prompt flag, so its boot prompt is PTY-injected after the banner.
    defaultCapabilities: MINIMAL_CAPABILITIES,
    autoApprove: true,
  },
  codex: {
    id: 'codex',
    displayName: 'Codex CLI',
    supportsAcp: false,
    acpCommand: ['codex', 'app-server'],
    // ⚠️ OPEN HAZARD, PRESERVED FROM THE DELETED ptyCommand — do not drop this
    // note just because the dead code it annotated is gone.
    //
    // Codex may carry the SAME identity defect Claude had: pty.ts hands the boot
    // prompt to codex as a PATH, and if codex's `--system-prompt` takes literal
    // TEXT (as Claude's does), every Codex pane boots with the path string as
    // its entire system prompt — no persona at all, and nothing in any
    // acceptance bar fails on it.
    //
    // NOBODY HAS VERIFIED CODEX'S FLAG SURFACE. It is a different CLI and may
    // take a path here, or use a different flag name. Fixing by analogy would
    // be guessing on a live spawn path. Needs the same A/B QAPert ran against
    // claude 2.1.220: same file both arms, check whether the persona takes.
    // (QAPert 2026-07-29.)
    defaultCapabilities: MINIMAL_CAPABILITIES,
  },
};

export function getProviderConfig(provider: TerminalProvider): ProviderConfig {
  return PROVIDER_CONFIGS[provider];
}
