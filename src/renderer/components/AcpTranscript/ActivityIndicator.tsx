import { Loader2 } from 'lucide-react';
import type { AcpWaitState } from '@shared/acpTypes';

interface ActivityIndicatorProps {
  status: 'thinking' | 'tool' | 'answering' | string;
  waitState?: AcpWaitState;
}

/**
 * Human label for a runtime wait-state frame. Keep it compact — it renders
 * inline next to the spinner in place of the generic status label, so the
 * user sees what the runtime is actually waiting on instead of a timer
 * guessing hang-vs-slow.
 */
function waitStateLabel(waitState: AcpWaitState): string {
  if (waitState.kind === 'provider_retry') {
    const attempt = waitState.nextAttempt ?? waitState.failedAttempt;
    const base =
      attempt !== undefined && waitState.maxAttempts !== undefined
        ? `Retrying provider (attempt ${attempt}/${waitState.maxAttempts})`
        : 'Retrying provider';
    // Surface the provider's error name (e.g. RateLimitError) — the adapter
    // already sends it; dropping it hides WHY the retry is happening.
    const parts = [base];
    if (waitState.errorName) parts.push(waitState.errorName);
    if (waitState.delayMs !== undefined) {
      parts.push(`next attempt in ${Math.max(1, Math.ceil(waitState.delayMs / 1000))}s`);
    }
    return parts.join(' — ');
  }
  if (waitState.kind === 'awaiting_first_token') return 'Waiting on provider';
  // Unknown/new kinds from newer runtimes degrade to a plain wait label.
  return 'Waiting';
}

export function ActivityIndicator({ status, waitState }: ActivityIndicatorProps) {
  const label =
    waitState ? waitStateLabel(waitState) :
    status === 'thinking' ? 'Thinking' :
    status === 'tool' ? 'Using tool' :
    status === 'answering' ? 'Answering' :
    'Working';

  return (
    <div className="flex items-center gap-2 text-slate-500 text-xs py-1" data-testid="activity-indicator">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      <span className="italic">{label}...</span>
    </div>
  );
}
