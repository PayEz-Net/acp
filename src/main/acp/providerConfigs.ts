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

/** kimi thinking efforts (reasoning_effort low/high/max per the model docs). */
const KIMI_THINKING_EFFORTS: ReadonlySet<string> = new Set(['low', 'high', 'max']);

/**
 * Env value for KIMI_MODEL_THINKING_EFFORT, or undefined when no injection
 * should happen.
 *
 * NOT k3-only. This used to gate on K3_FAMILY_MODELS = {k3, k3-256k}, on the
 * reasoning that another model "might not" accept the channel. That was our
 * invention. Measured in the shipped kimi.exe (2026-08-11):
 *
 *   function resolveKimiEnvThinkingEffort(thinkingEffort, kimiProvider, env) {
 *     if (!kimiProvider || thinkingEffort === "off") return undefined;
 *     return env["KIMI_MODEL_THINKING_EFFORT"]?.trim().toLowerCase() || undefined;
 *   }
 *
 * The only gates are "is a Kimi provider" and "thinking is not off", and the
 * vendor's own comment states the override "intentionally bypasses
 * support_efforts". The var binds to `thinking.forcedEffort` — forced, hence
 * no per-model catalogue check. kimi-for-coding also declares
 * capabilities ['thinking'] with default_thinking = true.
 *
 * The cost of the wrong gate was not "no effort" — it was the MODEL DEFAULT,
 * untunable, on every non-k3 agent. Effort maps to a thinking-token budget of
 * 1024 (low) / 4096 (medium) / 32000 (high): a 31x spread per turn.
 *
 * A model override is still required. That part was right and is kept: an
 * inherited default_model is not necessarily kimi at all, and effort is a
 * kimi-provider concept.
 *
 * A set-but-invalid effort warns and skips — never a silent wrong value.
 */
export function kimiThinkingEffortEnv(
  modelOverride: string | null | undefined,
  effort: string | undefined,
  onWarn: (message: string) => void,
): string | undefined {
  if (!modelOverride || !effort) return undefined;
  if (KIMI_THINKING_EFFORTS.has(effort)) return effort;
  onWarn(`effort_override '${effort}' is not a kimi thinking effort (low|high|max) — ignoring`);
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
    // WO-G4: stays false until the acceptance bar is met. The PTY path below
    // remains the live path; this is additive, not a cutover.
    supportsAcp: false,
    // Verified against claude 2.1.220 on the wire (2026-07-29). The previous
    // literal here could not have run: `--input-format`/`--output-format`
    // require `--print`, and token-level streaming requires
    // `--include-partial-messages`. See claudeStreamJson.ts.
    acpCommand: ['claude', ...CLAUDE_STREAM_JSON_ARGS],
    // PTY invocation: see buildClaudeSpawnCommand() in claudeSpawnCommand.ts.
    // It carries the --system-prompt-file / --effort / --model composition and
    // is unit-tested; the dead builder that used to sit here was not.
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
