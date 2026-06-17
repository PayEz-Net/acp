import { useEffect, useMemo } from 'react';
import { Play, Loader2, CheckCircle2, AlertTriangle, CircleDashed, Square } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import {
  useStandupRoundsStore,
  isCalmRound,
  blockerDiffFor,
  roundDoneState,
  filedCount,
  blockerByIdDiff,
  type BlockerDiff,
  type BlockerByIdDiff,
} from '../../stores/standupRoundsStore';
import type {
  StandupRound,
  StandupReport,
  StandupExpectedAgent,
  StandupBlocker,
  BlockerTriageState,
} from '@shared/types';

// The W4 actionable-loop check-in BOARD (#120): reads the durable current round
// and renders one card per expected agent (Did/Next/Blockers), blocker-first,
// with the M1-M4 overlays. Raw cards v1 — NO LLM roll-up (summary_md unrendered).
export function StandupRoundBoard() {
  const activeProject = useProjectStore((s) => s.activeProject);
  const projectId = activeProject?.id ?? null;
  const { currentRound, history, loading, error, acting, fetchCurrent, fetchHistory, callStandup, closeRound } =
    useStandupRoundsStore();

  useEffect(() => {
    if (projectId == null) return;
    fetchCurrent(projectId);
    fetchHistory(projectId);
  }, [projectId, fetchCurrent, fetchHistory]);

  // M2 — the previous round (highest round_id below the current) for the diff.
  const prevRound = useMemo<StandupRound | null>(() => {
    if (!currentRound) return null;
    const cur = Number(currentRound.round_id);
    return (
      history
        .filter((r) => Number(r.round_id) < cur)
        .sort((a, b) => Number(b.round_id) - Number(a.round_id))[0] ?? null
    );
  }, [currentRound, history]);

  if (projectId == null) {
    return <Empty>Select a project to see its standup.</Empty>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="flex items-center justify-between gap-2 p-3 border-b border-slate-700 shrink-0">
        <RoundStatusChip round={currentRound} />
        <div className="flex items-center gap-1">
          <button
            onClick={() => callStandup(projectId)}
            disabled={acting || currentRound?.status === 'open'}
            className="flex items-center gap-1 text-xs px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={currentRound?.status === 'open' ? 'A round is already open' : 'Call a standup — opens a round and notifies the team'}
          >
            {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            Call standup
          </button>
          {currentRound?.status === 'open' && (
            <button
              onClick={() => closeRound(projectId, currentRound.round_id)}
              disabled={acting}
              className="flex items-center gap-1 text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-colors disabled:opacity-50"
              title="Close this standup round"
            >
              <Square className="w-3 h-3" /> Close
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          // Fail-loud: surface the durable-round read error, never a silent fallback.
          <div className="m-3 p-3 rounded border border-red-500/40 bg-red-900/20 text-sm text-red-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading && !currentRound && (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="w-6 h-6 text-slate-500 animate-spin" />
          </div>
        )}

        {!loading && !error && !currentRound && (
          <Empty>No standup round yet. Call one to check in with the team.</Empty>
        )}

        {currentRound && <RoundBody round={currentRound} prevRound={prevRound} projectId={projectId} />}
      </div>
    </div>
  );
}

function RoundBody({
  round,
  prevRound,
  projectId,
}: {
  round: StandupRound;
  prevRound: StandupRound | null;
  projectId: number;
}) {
  const { filed, expected } = filedCount(round);
  const done = roundDoneState(round);
  const calm = isCalmRound(round);
  const { acting, triageBlocker } = useStandupRoundsStore();

  // #121 W5 — triage a blocker (explicit human disposition, never auto).
  const onTriage = (blockerId: string, state: BlockerTriageState) =>
    triageBlocker(projectId, round.round_id, blockerId, state);

  return (
    <div className="p-3 space-y-3">
      {/* M4 — done-state + #99 notify_status (sourced verbatim, never re-derived) */}
      <DoneStateLine done={done} filed={filed} expected={expected} notifyStatus={round.notify_status} />

      {/* M3 — quiet-when-calm: collapse to one line when no blockers are filed */}
      {calm ? (
        <div className="flex items-center gap-2 p-3 rounded border border-green-500/30 bg-green-900/15 text-sm text-green-300">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          All clear — {filed} of {expected} filed, no blockers.
        </div>
      ) : (
        <div className="space-y-2">
          {round.expected_agents.map((ea) => {
            const report = round.reports.find((r) => r.agent_id === ea.agent_id) ?? null;
            return (
              <ReportCard
                key={ea.agent_id}
                expected={ea}
                report={report}
                diff={blockerDiffFor(round, prevRound, ea.agent_id)}
                prevRound={prevRound}
                acting={acting}
                onTriage={onTriage}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReportCard({
  expected,
  report,
  diff,
  prevRound,
  acting,
  onTriage,
}: {
  expected: StandupExpectedAgent;
  report: StandupReport | null;
  diff: BlockerDiff;
  prevRound: StandupRound | null;
  acting: boolean;
  onTriage: (blockerId: string, state: BlockerTriageState) => void;
}) {
  const state = report?.state ?? 'pending';
  const faded = state !== 'reported'; // pending/absent are faded (not yet filed)
  const structured = report?.blockers ?? []; // #121 W5 source
  const hasStructured = structured.length > 0;
  // Fall back to the W4 free-text blocker only when no structured blockers exist
  // (pre-W5 / W5 backend not deployed) — no hard dependency on the W5 backend.
  const hasMdBlocker = !hasStructured && !!(report?.blockers_md && report.blockers_md.trim());
  const hasBlocker = hasStructured || hasMdBlocker;

  return (
    <div
      className={`rounded-lg border p-2.5 ${
        hasBlocker ? 'border-red-500/40 bg-red-900/10' : 'border-slate-700 bg-[#0d2137]'
      } ${faded ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-medium text-white">{expected.agent_name}</span>
        <StateBadge state={state} />
        {/* W4 agent-level diff only when there's no structured per-blocker diff. */}
        {!hasStructured && <BlockerDiffBadge diff={diff} />}
      </div>

      {report?.state === 'reported' ? (
        <div className="space-y-1.5 text-xs">
          {report.did_md && <Field label="Did" value={report.did_md} />}
          {report.next_md && <Field label="Next" value={report.next_md} />}

          {hasStructured && (
            <div className="space-y-1.5">
              <span className="text-red-400 font-semibold">Blockers</span>
              {structured.map((b) => (
                <BlockerRow
                  key={b.blocker_id}
                  blocker={b}
                  diff={blockerByIdDiff(b, prevRound)}
                  acting={acting}
                  onTriage={onTriage}
                />
              ))}
            </div>
          )}

          {hasMdBlocker && (
            <div>
              <span className="text-red-400 font-semibold">Blockers</span>
              <p className="text-red-200 whitespace-pre-wrap break-words mt-0.5">{report.blockers_md}</p>
            </div>
          )}

          {report.task_refs && report.task_refs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {report.task_refs.map((t) => (
                // M1 — observe-only: show the referenced kanban card id. No send
                // affordance on desktop (#53/#86); a real deep-link waits on a
                // task-ref->card resolver (no-dangling-affordance).
                <span
                  key={t}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 border border-slate-600"
                  title="Referenced kanban task"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-500 italic">
          {state === 'absent' ? 'Absent — no report' : 'Awaiting report'}
        </p>
      )}
    </div>
  );
}

// #121 W5 — one structured blocker: text + triage state (3 distinct, never
// collapsed) + the per-blocker diff badge + an open-thread deep-link (only when a
// thread exists) + explicit triage actions (Acknowledge / Resolve, never auto).
function BlockerRow({
  blocker,
  diff,
  acting,
  onTriage,
}: {
  blocker: StandupBlocker;
  diff: BlockerByIdDiff;
  acting: boolean;
  onTriage: (blockerId: string, state: BlockerTriageState) => void;
}) {
  return (
    <div className="rounded border border-red-500/25 bg-red-900/10 p-1.5">
      <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
        <TriageBadge state={blocker.triage_state} />
        <BlockerIdDiffBadge diff={diff} />
        {blocker.thread_id && (
          <span className="ml-auto text-[10px] text-blue-300" title="Has a linked discussion thread">
            thread linked
          </span>
        )}
      </div>
      <p className="text-red-200 whitespace-pre-wrap break-words">{blocker.text_md}</p>
      {blocker.triage_state !== 'resolved' && (
        <div className="flex items-center gap-1.5 mt-1">
          {blocker.triage_state === 'open' && (
            <button
              onClick={() => onTriage(blocker.blocker_id, 'acknowledged')}
              disabled={acting}
              className="text-[10px] px-1.5 py-0.5 rounded bg-amber-600/30 text-amber-200 hover:bg-amber-600/50 disabled:opacity-50"
            >
              Acknowledge
            </button>
          )}
          <button
            onClick={() => onTriage(blocker.blocker_id, 'resolved')}
            disabled={acting}
            className="text-[10px] px-1.5 py-0.5 rounded bg-green-700/30 text-green-200 hover:bg-green-700/50 disabled:opacity-50"
          >
            Resolve
          </button>
        </div>
      )}
    </div>
  );
}

function TriageBadge({ state }: { state: BlockerTriageState }) {
  const map: Record<BlockerTriageState, { label: string; cls: string }> = {
    open: { label: 'open', cls: 'text-red-200 bg-red-900/40 border-red-500/60' },
    acknowledged: { label: 'acknowledged', cls: 'text-amber-200 bg-amber-900/30 border-amber-500/50' },
    resolved: { label: 'resolved', cls: 'text-green-200 bg-green-900/30 border-green-500/50' },
  };
  const m = map[state];
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${m.cls}`}>{m.label}</span>;
}

function BlockerIdDiffBadge({ diff }: { diff: BlockerByIdDiff }) {
  const map: Record<BlockerByIdDiff, { label: string; cls: string } | null> = {
    new: { label: 'new', cls: 'text-red-300 bg-red-900/30 border-red-500/40' },
    carried: { label: 'STALLED', cls: 'text-red-200 bg-red-900/40 border-red-500/60 font-semibold' },
    cleared: null, // a resolved blocker already shows the resolved triage badge
  };
  const m = map[diff];
  if (!m) return null;
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${m.cls}`}>{m.label}</span>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-slate-500 font-medium">{label}</span>
      <p className="text-slate-300 whitespace-pre-wrap break-words mt-0.5">{value}</p>
    </div>
  );
}

function StateBadge({ state }: { state: StandupReport['state'] }) {
  const map: Record<StandupReport['state'], { label: string; cls: string }> = {
    reported: { label: 'reported', cls: 'text-green-300 bg-green-900/30' },
    pending: { label: 'pending', cls: 'text-slate-400 bg-slate-800' },
    absent: { label: 'absent', cls: 'text-amber-300 bg-amber-900/30' },
  };
  const m = map[state];
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.cls}`}>{m.label}</span>;
}

function BlockerDiffBadge({ diff }: { diff: BlockerDiff }) {
  if (diff === 'none') return null;
  const map: Record<Exclude<BlockerDiff, 'none'>, { label: string; cls: string }> = {
    new: { label: 'new blocker', cls: 'text-red-300 bg-red-900/30 border-red-500/40' },
    stalled: { label: 'STALLED', cls: 'text-red-200 bg-red-900/40 border-red-500/60 font-semibold' },
    cleared: { label: 'cleared', cls: 'text-green-300 bg-green-900/30 border-green-500/40' },
  };
  const m = map[diff];
  return <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border ${m.cls}`}>{m.label}</span>;
}

function DoneStateLine({
  done,
  filed,
  expected,
  notifyStatus,
}: {
  done: ReturnType<typeof roundDoneState>;
  filed: number;
  expected: number;
  notifyStatus: string;
}) {
  const map = {
    'no-team': { icon: CircleDashed, cls: 'text-slate-400', text: 'No team on this round (N/A)' },
    'in-progress': { icon: CircleDashed, cls: 'text-blue-300', text: `In progress — ${filed}/${expected} filed` },
    complete: { icon: CheckCircle2, cls: 'text-green-300', text: `Complete — all ${expected} filed` },
    'closed-partial': { icon: AlertTriangle, cls: 'text-amber-300', text: `Closed — only ${filed}/${expected} filed` },
  } as const;
  const m = map[done];
  const Icon = m.icon;
  return (
    <div className="flex items-center gap-2 text-xs">
      <Icon className={`w-4 h-4 ${m.cls}`} />
      <span className={m.cls}>{m.text}</span>
      {/* #99 notify-on-open outcome, surfaced verbatim from the round state. */}
      <span className="ml-auto text-slate-500" title="Open-notify outcome (#99)">
        notify: {notifyStatus}
      </span>
    </div>
  );
}

function RoundStatusChip({ round }: { round: StandupRound | null }) {
  if (!round) return <span className="text-xs text-slate-500">No active round</span>;
  const open = round.status === 'open';
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className={`w-1.5 h-1.5 rounded-full ${open ? 'bg-green-400' : 'bg-slate-500'}`} />
      <span className="text-slate-300">Round {round.round_id}</span>
      <span className="text-slate-500">· {open ? 'open' : 'closed'}</span>
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-8 text-center text-sm text-slate-500">{children}</div>;
}
