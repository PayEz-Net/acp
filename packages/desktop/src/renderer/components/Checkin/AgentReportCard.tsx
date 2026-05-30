import { CheckCircle2, Clock, MinusCircle } from 'lucide-react';
import type { StandupReport, ReportState } from '../../checkin/types';

/**
 * One agent's check-in card: Did / Next / Blockers + last-reported time +
 * task chips. Pending/absent agents render faded (the dev sees who hasn't
 * reported). Raw cards (D3) — no LLM roll-up. No emoji (lucide icons).
 */

interface AgentReportCardProps {
  name: string;
  report: StandupReport | null;
}

const STATE_TONE: Record<ReportState, string> = {
  reported: 'text-emerald-400',
  pending: 'text-amber-400',
  absent: 'text-slate-500',
};

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value || !value.trim()) return null;
  return (
    <div className="mt-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-slate-300">{value}</p>
    </div>
  );
}

export function AgentReportCard({ name, report }: AgentReportCardProps) {
  const state: ReportState = report?.state ?? 'pending';
  const reported = state === 'reported' && !!report;
  const Icon = state === 'reported' ? CheckCircle2 : state === 'pending' ? Clock : MinusCircle;

  return (
    <div
      className={`flex h-full flex-col rounded-lg border border-slate-700 bg-slate-800/40 p-4 ${reported ? '' : 'opacity-60'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold text-slate-100">{report?.agent_name || name}</span>
        <span className={`inline-flex flex-shrink-0 items-center gap-1 text-[10px] font-medium uppercase tracking-wider ${STATE_TONE[state]}`}>
          <Icon className="h-3 w-3" />
          {state}
        </span>
      </div>

      {reported && report ? (
        <>
          <Field label="Did" value={report.did_md} />
          <Field label="Next" value={report.next_md} />
          {report.blockers_md && report.blockers_md.trim() && (
            <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 p-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">Blockers</div>
              <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-amber-200/90">{report.blockers_md}</p>
            </div>
          )}
          {report.task_refs && report.task_refs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {report.task_refs.map((t) => (
                <span key={t} className="rounded bg-slate-700/60 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                  {t}
                </span>
              ))}
            </div>
          )}
          {report.reported_at && (
            <div className="mt-auto pt-2 text-[10px] text-slate-500">reported {timeAgo(report.reported_at)}</div>
          )}
        </>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          {state === 'absent' ? "Didn't report this round." : 'Waiting for their check-in…'}
        </p>
      )}
    </div>
  );
}
