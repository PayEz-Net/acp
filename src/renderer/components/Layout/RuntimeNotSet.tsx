import { useId } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';

// Runtime-not-set block surface (SPEC-team-runtime §3.3 — Jon re-scope).
//
// An active project with no team runtime cannot instantiate: spawnAgent
// BLOCKS (RuntimeNotSetError) rather than launching a silent default
// provider — a warned default would be the same masking fallback in a hi-vis
// vest (feedback_fallback_to_avoid_crash_is_the_hole). This surface tells the
// user to choose a runtime; the choice lives on idealvibe.online (the runtime
// is web-edited — ACP project settings are read-only). team-create guarantees
// runtime_choice NOT NULL, so this is a defensive surface that should rarely
// fire — but it is NEVER swallowed.

export function RuntimeNotSet() {
  const issue = useProjectStore((s) => s.runtimeNotSet);
  const clear = useProjectStore((s) => s.clearRuntimeNotSet);
  const titleId = useId();

  if (!issue) return null;

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
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <span id={titleId} className="text-sm font-semibold text-slate-100">
              Team runtime not set — choose one
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-4">
          <p className="text-xs text-slate-400 leading-relaxed">
            <span className="text-slate-300 font-medium">{issue.projectName}</span> doesn&apos;t have a
            team runtime selected, so its agents can&apos;t start. Choose a runtime
            (<span className="text-slate-200">Claude</span> / <span className="text-slate-200">Kimi</span> /{' '}
            <span className="text-slate-200">Codex</span>) for this project on idealvibe.online, then
            reopen it.
          </p>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-700 px-3 py-2.5 flex items-center justify-between gap-2">
          <a
            href="https://idealvibe.online/dashboard/vibe-projects"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 px-2 py-1.5"
          >
            <ExternalLink className="w-3 h-3" />
            Open idealvibe.online
          </a>
          <button
            type="button"
            onClick={clear}
            className="text-xs text-slate-400 hover:text-slate-200 px-3 py-1.5"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
