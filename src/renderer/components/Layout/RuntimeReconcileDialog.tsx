import { useId } from 'react';
import { RefreshCw } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';

// Reconcile-on-switch confirm dialog (SPEC-team-runtime §3.2 / §4).
//
// When opening/switching a project — or when its team runtime changes —
// reconcile restarts any RUNNING agent on a provider != the team runtime so
// the whole team conforms to one runtime. Restarting drops that pane's
// in-flight session, so this is CONFIRM-FIRST: silent default = do NOT kill
// (consent-first). A fresh open with nothing running never reaches this
// surface (the store sets no plan when there's nothing to conform).
//
// Copy is canonical §4 — terse, names both providers and the count.

export function RuntimeReconcileDialog() {
  const plan = useProjectStore((s) => s.runtimeReconcile);
  const confirm = useProjectStore((s) => s.confirmRuntimeReconcile);
  const cancel = useProjectStore((s) => s.cancelRuntimeReconcile);
  const titleId = useId();

  if (!plan) return null;

  const count = plan.agents.length;
  // The §4 copy names the providers the running agents are on. Usually they
  // share one (the prior team runtime); if mixed, say "a different runtime"
  // rather than over-specifying.
  const froms = Array.from(new Set(plan.agents.map((a) => a.from)));
  const fromLabel = froms.length === 1 ? froms[0] : 'a different runtime';
  const agentWord = count === 1 ? 'agent is' : 'agents are';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[30rem] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-violet-400 flex-shrink-0" />
            <span id={titleId} className="text-sm font-semibold text-slate-100">
              Switch runtime for this team?
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-4">
          <p className="text-xs text-slate-400 leading-relaxed">
            This project runs on{' '}
            <span className="text-slate-200 font-semibold uppercase">{plan.teamRuntime}</span>.{' '}
            <span className="text-slate-200 font-medium">{count}</span> running {agentWord} on{' '}
            <span className="text-slate-200 font-semibold uppercase">{fromLabel}</span> and will
            restart to match — any in-progress work in {count === 1 ? 'that pane' : 'those panes'} will
            stop.
          </p>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-700 px-3 py-2.5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="text-xs text-slate-400 hover:text-slate-200 px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            autoFocus
            className="text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 rounded px-3 py-1.5"
          >
            Restart team on {plan.teamRuntime}
          </button>
        </div>
      </div>
    </div>
  );
}
