/**
 * Supported code CLI runtimes.
 *
 * The renderer never invents a default — the active project's `runtime_choice`
 * (or an agent's explicit `provider` override) is the single authority. These
 * helpers centralize provider-specific colors/labels/behaviour so Claude, Kimi,
 * and Codex concerns stay segregated in one place.
 */
export type CodeProvider = 'claude' | 'kimi' | 'codex';

export const CODE_PROVIDERS: CodeProvider[] = ['claude', 'kimi', 'codex'];

export const PROVIDER_LABELS: Record<CodeProvider, string> = {
  claude: 'Claude',
  kimi: 'Kimi',
  codex: 'Codex',
};

/**
 * Visual badges for the active runtime chip shown on each terminal pane.
 * Keep these distinct so a mixed-mode team is readable at a glance.
 */
export const providerBadgeClasses = (provider: CodeProvider | null | undefined): string => {
  switch (provider) {
    case 'claude':
      return 'bg-amber-500/15 text-amber-300';
    case 'kimi':
      return 'bg-violet-500/15 text-violet-300';
    case 'codex':
      return 'bg-cyan-500/15 text-cyan-300';
    default:
      return 'bg-slate-500/15 text-slate-400';
  }
};

export const providerLabel = (provider: CodeProvider | null | undefined): string =>
  provider ? PROVIDER_LABELS[provider] : 'Auto';

/**
 * Resolve the effective provider for an agent.
 * 1. Agent-level override (`agent.provider`)
 * 2. Team-level runtime (`teamRuntime` from active project)
 * 3. Global fallback (`fallback` from settings)
 *
 * This makes per-agent overrides work without leaking provider checks into
 * every component.
 */
interface ProviderHolder {
  provider?: CodeProvider;
}

export function resolveAgentProvider(
  agent: ProviderHolder | null | undefined,
  teamRuntime: CodeProvider | null | undefined,
  fallback: CodeProvider | null | undefined,
): CodeProvider {
  return agent?.provider ?? teamRuntime ?? fallback ?? 'claude';
}

/**
 * Provider-specific mail push strategy.
 *
 * Claude Code has a first-class MCP channel push (handled server-side by
 * acp-mail-channel.js). Kimi and Codex do not, so we inject a visible PTY
 * notice so the running agent actually sees the mail arrived.
 */
export function shouldInjectMailToPty(provider: CodeProvider): boolean {
  return provider !== 'claude';
}
