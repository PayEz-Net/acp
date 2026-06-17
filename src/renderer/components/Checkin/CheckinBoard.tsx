import { useEffect, useMemo } from 'react';
import { Loader2, AlertCircle, ClipboardList, RefreshCw, Megaphone } from 'lucide-react';
import { useCheckinStore } from '../../stores/checkinStore';
import { AgentReportCard } from './AgentReportCard';
import { roundCards } from '../../checkin/cards';

/**
 * The Team Check-in board (W3): the current/most-recent round as a card per
 * agent. Reads DURABLE rounds via the store; on a read error it FAILS LOUD
 * (surfaces the error + retry) and NEVER falls back to the activity ring
 * (D2 + Aurum #2). Empty-state when the project has no round yet.
 */

function CallStandupButton({ compact }: { compact?: boolean }) {
  const calling = useCheckinStore((s) => s.calling);
  const callStandup = useCheckinStore((s) => s.callStandup);
  return (
    <button
      onClick={() => void callStandup()}
      disabled={calling}
      className={`inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 ${
        compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
      }`}
    >
      <Megaphone className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      {calling ? 'Calling…' : 'Call standup'}
    </button>
  );
}

export function CheckinBoard() {
  const currentRound = useCheckinStore((s) => s.currentRound);
  const loading = useCheckinStore((s) => s.loading);
  const error = useCheckinStore((s) => s.error);
  const callError = useCheckinStore((s) => s.callError);
  const loadCurrentRound = useCheckinStore((s) => s.loadCurrentRound);

  useEffect(() => {
    void loadCurrentRound();
  }, [loadCurrentRound]);

  const cards = useMemo(() => (currentRound ? roundCards(currentRound) : []), [currentRound]);

  if (loading && !currentRound) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the check-in…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-center">
        <AlertCircle className="h-8 w-8 text-red-400" />
        <p className="text-sm text-slate-300">Couldn&apos;t load the check-in.</p>
        <p className="max-w-md text-xs text-slate-500">{error}</p>
        <button
          onClick={() => void loadCurrentRound()}
          className="mt-1 rounded border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!currentRound) {
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-center">
        <ClipboardList className="h-8 w-8 text-slate-600" />
        <p className="text-sm text-slate-400">No check-in round yet for this project.</p>
        <p className="max-w-sm text-xs text-slate-500">
          Call a standup to ask the team for did / next / blockers — their reports land here as cards.
        </p>
        <div className="mt-1">
          <CallStandupButton />
        </div>
        {callError && <p className="mt-1 max-w-md text-xs text-red-400">{callError}</p>}
      </div>
    );
  }

  const round = currentRound;
  const reportedCount = round.reports.filter((r) => r.state === 'reported').length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-slate-700 py-3 pl-4 pr-12">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-200">Team Check-in</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                round.status === 'open' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-slate-700 text-slate-400'
              }`}
            >
              {round.status}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-slate-500">
            {reportedCount}/{cards.length} reported · called by {round.called_by} ·{' '}
            {new Date(round.started_at).toLocaleString()}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <CallStandupButton compact />
          <button
            onClick={() => void loadCurrentRound()}
            title="Refresh"
            className="p-1.5 text-slate-400 hover:text-slate-200"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {callError && (
        <div className="border-b border-red-800/40 bg-red-900/20 px-4 py-2 text-xs text-red-300">{callError}</div>
      )}

      <div className="grid flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto p-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <AgentReportCard key={c.name} name={c.name} report={c.report} />
        ))}
      </div>
    </div>
  );
}
