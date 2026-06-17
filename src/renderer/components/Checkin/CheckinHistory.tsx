import { useEffect, useState } from 'react';
import { Loader2, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { useCheckinStore } from '../../stores/checkinStore';
import { AgentReportCard } from './AgentReportCard';
import { roundCards } from '../../checkin/cards';

/**
 * Past rounds (§6.4) — durable + shared, newest first. Each row is scannable
 * (date · status · reported count · who called it) and expands to that round's
 * per-agent cards. Reads durable rounds; FAILS LOUD on error (no ring).
 */
export function CheckinHistory() {
  const history = useCheckinStore((s) => s.history);
  const loading = useCheckinStore((s) => s.historyLoading);
  const error = useCheckinStore((s) => s.historyError);
  const loadHistory = useCheckinStore((s) => s.loadHistory);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  if (loading && history.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-center">
        <AlertCircle className="h-8 w-8 text-red-400" />
        <p className="text-sm text-slate-300">Couldn&apos;t load check-in history.</p>
        <p className="max-w-md text-xs text-slate-500">{error}</p>
        <button
          onClick={() => void loadHistory()}
          className="mt-1 rounded border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700"
        >
          Retry
        </button>
      </div>
    );
  }

  if (history.length === 0) {
    return <div className="p-10 text-center text-sm text-slate-500">No past check-ins yet.</div>;
  }

  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-4">
      {history.map((round) => {
        const cards = roundCards(round);
        const reported = round.reports.filter((r) => r.state === 'reported').length;
        const isOpen = expanded === round.round_id;
        const Chevron = isOpen ? ChevronDown : ChevronRight;
        return (
          <div key={round.round_id} className="rounded-lg border border-slate-700 bg-slate-800/40">
            <button
              onClick={() => setExpanded(isOpen ? null : round.round_id)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-slate-800/60"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Chevron className="h-4 w-4 flex-shrink-0 text-slate-500" />
                <span className="truncate text-sm text-slate-200">{new Date(round.started_at).toLocaleString()}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                    round.status === 'open' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-slate-700 text-slate-400'
                  }`}
                >
                  {round.status}
                </span>
              </span>
              <span className="flex-shrink-0 text-[11px] text-slate-500">
                {reported}/{cards.length} reported · {round.called_by}
              </span>
            </button>
            {isOpen && (
              <div className="grid grid-cols-1 gap-2 border-t border-slate-700 p-3 sm:grid-cols-2 lg:grid-cols-3">
                {cards.map((c) => (
                  <AgentReportCard key={c.name} name={c.name} report={c.report} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
