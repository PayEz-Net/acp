import { useState, useRef, useEffect, useId } from 'react';
import { FolderX, ExternalLink, Loader2 } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';

// Inline working-folder correction surface (SPEC-workdir-invalid §3.5 + §3.6).
//
// The headline fix-forward: when a project's repo_path doesn't resolve on THIS
// machine, the open flow refuses to instantiate (spawns ZERO agents) and shows
// this surface instead of letting 5 panes throw an opaque 500. The user fixes
// the path right here — we validate it (main-process resolveWorkDir), persist it
// via the held session bearer (PUT /v1/projects/:id, X-Client-Id from the token,
// NOT hardcoded), then run the spawn fan-out that was gated.
//
// Built reusable on purpose: §3.4 mounts this SAME component for the
// reactive/orchestrator path (a path that goes bad AFTER open). It owns no
// open/picker state — the parent passes the offending project + path and the
// continuation callbacks, so it drops into either flow.
//
// Guardrails honored verbatim (§5 + memory):
//   - Validate-BEFORE-save: a typed path that also doesn't resolve → inline
//     field error, persist NOTHING (no writing a 2nd bad path).
//   - No fallback / auto-pick: the field starts pre-filled with the bad path;
//     we never guess a folder.
//   - Failed write halts legibly: the verbatim cloud error is shown and we do
//     NOT proceed (feedback_fallback_to_avoid_crash_is_the_hole).
//   - Copy is canonical §4 — terse, house voice, no stack trace in the banner.
//
// Accessibility (QAPert WO 3.5+3.6 follow-up, pre-public-gate): the field has a
// programmatic label + aria-invalid/aria-describedby; both error nodes are
// role="alert" so a screen reader announces them; the modal is a labelled
// role="dialog" aria-modal with a focus trap and Escape-to-dismiss (→ Pick
// another, the non-destructive exit — nothing persisted, nothing spawned).

export interface WorkdirCorrectionProps {
  /**
   * The project whose working folder is invalid. `null` only in the §3.4
   * no-active-project edge (an orchestrator WORKDIR_INVALID arrived before the
   * renderer hydrated a project) — the surface still shows so the failure isn't
   * swallowed, but the inline save is gated (no row to write back to).
   */
  projectId: number | null;
  projectName: string;
  /** The repo_path that failed to resolve on this machine (pre-fills the field). */
  badPath: string;
  /**
   * Called after the corrected path validates AND persists. The parent runs
   * the spawn fan-out that pre-flight was gating (the team finally instantiates).
   * Receives the saved path for convenience.
   */
  onResolved: (savedPath: string) => void;
  /** Secondary CTA — open the project picker to choose a different project. */
  onPickAnother: () => void;
}

export function WorkdirCorrection({
  projectId,
  projectName,
  badPath,
  onResolved,
  onPickAnother,
}: WorkdirCorrectionProps) {
  const updateProjectRepoPath = useProjectStore((s) => s.updateProjectRepoPath);

  const [path, setPath] = useState(badPath);
  const [busy, setBusy] = useState(false);
  // Field-level error (validate-before-save miss). Distinct from writeError so
  // "that path isn't here either" reads differently from "the save failed".
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  // Stable ids to associate the input with its label, help text, and errors
  // (a screen reader reads the description when focus lands on the field).
  const titleId = useId();
  const inputId = useId();
  const fieldErrorId = useId();
  const writeErrorId = useId();

  const dialogRef = useRef<HTMLDivElement>(null);
  // Latest onPickAnother without re-subscribing the keydown listener each render
  // (App passes a fresh closure every render; Escape must call the current one).
  const onPickAnotherRef = useRef(onPickAnother);
  onPickAnotherRef.current = onPickAnother;

  // Focus trap + Escape-to-dismiss (WCAG 2.1.2 / 2.4.3). The field's autoFocus
  // handles initial focus; this keeps Tab within the dialog and routes Escape
  // to the non-destructive exit.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onPickAnotherRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !node.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleSave = async () => {
    // No project loaded to write back to — Save is gated in the UI; this is a
    // defensive guard so a stray Enter can't try to persist against a null id.
    if (projectId === null) return;
    const candidate = path.trim();
    setFieldError(null);
    setWriteError(null);
    if (!candidate) {
      setFieldError('Enter a working folder path.');
      return;
    }

    setBusy(true);
    try {
      // 1. Validate BEFORE persisting — same main-process authority the spawn
      //    guard uses, so a pass here is a path spawnAgent won't reject.
      const check = await window.electronAPI.validateWorkDir(candidate);
      if (!check.ok) {
        setFieldError("That path isn't on this machine either.");
        return; // persist NOTHING
      }

      // 2. Persist via the authed write-back lane (held bearer + token tenant).
      const result = await updateProjectRepoPath(projectId, check.resolved ?? candidate);
      if (!result.ok) {
        // Verbatim cloud error — halt legibly, do not proceed, no fallback.
        setWriteError(result.error || 'Saving the working folder failed.');
        return;
      }

      // 3. Clear + hand control back so the parent instantiates the team.
      onResolved(check.resolved ?? candidate);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // The field's accessible NAME comes from the associated <label htmlFor>. Its
  // DESCRIPTION is whichever error is currently shown, so a screen reader
  // announces the validation/save failure on focus (not just visually).
  const describedBy = [fieldError ? fieldErrorId : null, writeError ? writeErrorId : null]
    .filter(Boolean)
    .join(' ');

  // Whether the inline fix-forward can persist. False only in the §3.4
  // no-active-project edge (orchestrator fired WORKDIR_INVALID before the
  // renderer hydrated a project): we still SURFACE the failure (never swallow),
  // but there's no project row to write back to, so Save is gated → Pick another.
  const canSave = projectId !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[30rem] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <FolderX className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <span id={titleId} className="text-sm font-semibold text-slate-100">
              Can&apos;t open this project — working folder isn&apos;t on this machine
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-4 flex flex-col gap-3">
          <p className="text-xs text-slate-400 leading-relaxed">
            <span className="text-slate-300 font-medium">{projectName}</span>&apos;s working folder
            doesn&apos;t exist here:
          </p>
          <code className="block text-[11px] text-amber-300/90 bg-slate-950/60 border border-slate-800 rounded px-2 py-1.5 break-all">
            {badPath || '(empty)'}
          </code>
          <label htmlFor={inputId} className="text-xs text-slate-400 leading-relaxed">
            Enter the correct path for <span className="text-slate-200 font-medium">this machine</span>{' '}
            and we&apos;ll save it and keep going:
          </label>

          <div className="flex flex-col gap-1">
            <input
              id={inputId}
              type="text"
              value={path}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={describedBy || undefined}
              onChange={(e) => {
                setPath(e.target.value);
                if (fieldError) setFieldError(null);
                if (writeError) setWriteError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) handleSave();
              }}
              spellCheck={false}
              autoFocus
              placeholder="Full path to the project folder on this machine"
              className={`w-full bg-slate-950 border rounded px-2.5 py-1.5 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus:ring-1 ${
                fieldError
                  ? 'border-red-500/60 focus:ring-red-500/50'
                  : 'border-slate-700 focus:ring-emerald-500/50'
              }`}
            />
            {fieldError && (
              <p id={fieldErrorId} role="alert" className="text-xs text-red-400">
                {fieldError}
              </p>
            )}
          </div>

          {writeError && (
            <div
              id={writeErrorId}
              role="alert"
              className="px-2.5 py-2 rounded bg-red-500/10 border border-red-500/30"
            >
              <p className="text-xs text-red-300 break-words">
                Couldn&apos;t save: {writeError}
              </p>
            </div>
          )}

          {!canSave && (
            <p className="text-xs text-amber-300/90 leading-relaxed">
              No project is loaded to save this to — pick a project to set its working folder.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-700 px-3 py-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={onPickAnother}
            disabled={busy}
            className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1.5 disabled:opacity-50"
          >
            Pick another project
          </button>
          <a
            href="https://idealvibe.online/dashboard/vibe-projects"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 px-2 py-1.5"
          >
            <ExternalLink className="w-3 h-3" />
            manage in idealvibe
          </a>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || !canSave}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {busy ? 'Saving…' : 'Save & open'}
          </button>
        </div>
      </div>
    </div>
  );
}
