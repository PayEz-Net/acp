import { AgentState } from '@shared/types';
import { useAgentStatusStore } from '../../stores/agentStatusStore';
import { useAcpSessionStore } from '../../stores/acpSessionStore';

export type StatusPill = {
  label: string;
  color: string;
  animate?: boolean;
};

export function getStatusPill(status: AgentState['status']): StatusPill {
  switch (status) {
    case 'offline':
      return { label: 'Offline', color: 'bg-acp-status-offline' };
    case 'starting':
      return { label: 'Starting…', color: 'bg-acp-accent', animate: true };
    case 'ready':
      return { label: 'Ready', color: 'bg-acp-status-ready' };
    case 'busy':
      return { label: 'Busy', color: 'bg-acp-status-busy', animate: true };
    case 'idle':
      return { label: 'Idle', color: 'bg-acp-status-idle' };
    case 'error':
      return { label: 'Error', color: 'bg-acp-status-error' };
    default:
      return { label: status, color: 'bg-acp-status-offline' };
  }
}

export function ContextBar({ usage }: { usage: number }) {
  const clamped = Math.max(0, Math.min(100, usage));
  let color = 'bg-emerald-500';
  if (clamped > 70) color = 'bg-red-500';
  else if (clamped > 40) color = 'bg-yellow-500';
  return (
    <div className="w-16 h-1.5 bg-acp-surface-raised rounded-full overflow-hidden" title={`Context usage: ${clamped}%`}>
      <div className={`h-full ${color}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

function formatTokens(n?: number): string | undefined {
  if (n === undefined || Number.isNaN(n)) return undefined;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function TerminalFooter({
  agent,
  provider,
  repoPath,
  lineCount,
  thinkingCount,
  contextUsage,
}: {
  agent: AgentState;
  provider: string | null;
  repoPath: string;
  lineCount: number;
  thinkingCount: number;
  contextUsage: number;
}) {
  const status = useAgentStatusStore((s) => s.statuses[agent.name]);
  const acpSession = useAcpSessionStore((s) => s.sessions.get(agent.name));
  const isAcpMode = acpSession?.runtimeMode === 'acp';

  // The provider prop is the single source of truth (agent.provider with the
  // team-runtime fallback already applied by the caller). Do not let the status
  // store override it — that creates dueling provider badges.
  const effectiveProvider = provider;
  const effectiveModel = isAcpMode
    ? acpSession?.agentInfo?.model ??
      (acpSession?.agentInfo?.version
        ? `${acpSession.agentInfo.name} ${acpSession.agentInfo.version}`
        : acpSession?.agentInfo?.name)
    : status?.model;
  // Per-agent effort (claude only — the manager leaves it unset for kimi/codex,
  // which ignore effort). It's the one override that now varies per agent.
  const effectiveEffort = isAcpMode ? acpSession?.agentInfo?.effort : undefined;
  const effectiveCwd = status?.cwd ?? repoPath;
  const effectiveContext = status?.contextUsage ?? contextUsage;
  const effectiveTokenUsed = status?.tokenUsed;
  const effectiveTokenMax = status?.tokenMax;
  const composing = status?.composing;

  const displayPath = effectiveCwd.split(/[\\/]/).filter(Boolean).slice(-2).join('\\') || '—';

  const tokenLabel =
    effectiveTokenUsed !== undefined && effectiveTokenMax !== undefined
      ? `${formatTokens(effectiveTokenUsed)}/${formatTokens(effectiveTokenMax)}`
      : effectiveTokenUsed !== undefined
      ? formatTokens(effectiveTokenUsed)
      : undefined;

  return (
    <div className="h-6 shrink-0 flex items-center justify-between px-2.5 border-t border-acp-border bg-acp-surface text-[10px] text-acp-text-muted">
      <div className="flex items-center gap-2.5 min-w-0">
        {effectiveProvider && (
          <span className="uppercase tracking-wide text-acp-text-secondary" title={effectiveModel ?? ''}>
            {effectiveProvider}
          </span>
        )}
        {effectiveModel && effectiveProvider !== effectiveModel && (
          <span className="text-acp-text-secondary truncate max-w-[6rem]" title={effectiveModel}>
            {effectiveModel}
          </span>
        )}
        {effectiveEffort && (
          <span className="uppercase tracking-wide text-acp-text-muted" title={`Effort: ${effectiveEffort}`}>
            {effectiveEffort}
          </span>
        )}
        <span className="truncate max-w-[12rem]" title={effectiveCwd || 'No project path'}>
          {displayPath}
        </span>
      </div>

      <div className="flex items-center gap-2.5 shrink-0">
        {composing && (
          <span className="text-acp-status-busy" title={`Composing ${composing.duration} · ${composing.tokens} tokens`}>
            {composing.duration} · {formatTokens(composing.tokens)}t
          </span>
        )}
        {thinkingCount > 0 && (
          <span className="text-acp-status-busy" title={`${thinkingCount} thinking block(s)`}>
            {thinkingCount}
          </span>
        )}
        {tokenLabel && (
          <span title="Token usage">{tokenLabel}</span>
        )}
        <span title={`${lineCount} output line(s)`}>{lineCount} lines</span>
        <ContextBar usage={effectiveContext} />
      </div>
    </div>
  );
}
