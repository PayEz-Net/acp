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

export function ContextBar({ usage }: { usage?: number }) {
  // UNKNOWN is not 0. contextUsage is screen-scraped out of terminal text
  // (terminalStream.ts STATUS_EXTRACTORS, /context: N%/), and that string only
  // shows up once the runtime is nearly out of room — so for the whole useful
  // range there is no reading at all. Painting that as 0% drew a full-width
  // GREEN bar meaning "plenty of headroom" on every pane, which is a confident
  // wrong answer rather than a missing one. Absence prompts the question; a
  // green bar answers it wrongly.
  if (usage === undefined || Number.isNaN(usage)) {
    return (
      <div
        className="w-16 h-1.5 rounded-full border border-dashed border-acp-border"
        title="Context usage: unknown — this runtime does not report it until it is nearly full"
      />
    );
  }
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
  thinkingCount,
  contextUsage,
}: {
  agent: AgentState;
  provider: string | null;
  repoPath: string;
  thinkingCount: number;
  contextUsage?: number;
}) {
  const status = useAgentStatusStore((s) => s.statuses[agent.name]);
  const acpSession = useAcpSessionStore((s) => s.sessions.get(agent.name));
  const isAcpMode = acpSession?.runtimeMode === 'acp';

  // The provider prop is the single source of truth (agent.provider with the
  // team-runtime fallback already applied by the caller). Do not let the status
  // store override it — that creates dueling provider badges.
  const effectiveProvider = provider;
  const effectiveModel = isAcpMode
    ? acpSession?.agentInfo?.version
      ? `${acpSession.agentInfo.name} ${acpSession.agentInfo.version}`
      : acpSession?.agentInfo?.name
    : status?.model;
  const effectiveCwd = status?.cwd ?? repoPath;
  const effectiveContext = status?.contextUsage ?? contextUsage;  // may be undefined = never reported
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
        <ContextBar usage={effectiveContext} />
      </div>
    </div>
  );
}
