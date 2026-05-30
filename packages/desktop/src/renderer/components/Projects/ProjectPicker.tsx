import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Check, ChevronDown, ChevronUp, ExternalLink, Sparkles } from 'lucide-react';
import { useProjectStore, Project } from '../../stores/projectStore';
// useAppStore import removed — its only use here was the team-builder auto-open, now hidden (WO #47, ACP read-only).

interface ProjectPickerProps {
  isOpen: boolean;
  onClose: () => void;
}

// Always-picker boot front-door per BAPert msg 1023 chrome.
// Three modes drive rendering, derived from current_project_state:
//   'stored-confirm'    — current project pre-highlighted; [Pick another]
//                          inline-expands the list. [Start] closes (or
//                          calls switchProject if user picked a different
//                          project).
//   'first-boot-prompt' — full list, no default highlight, [Start] enabled
//                          after selection. State='unset' on cloud.
//   'create-cta'        — no list, "Open idealvibe.online" link. State='empty'.
//
// Picker is always-modal until [Start] (no Cancel/Escape dismiss in the
// new chrome — user must commit). After first [Start] click, picker can
// be re-opened via title-bar pill for browse/switch.
//
// switchProject is currently a fail-loud stub (Wave C replaces with the
// six-stage instantiation lifecycle). switchError surfaces the
// PROJECT_SWITCH_NOT_IMPLEMENTED message inline as the friendly Wave C
// "restart for now" copy.
export function ProjectPicker({ isOpen, onClose }: ProjectPickerProps) {
  const {
    projects,
    activeProject,
    loading,
    fetchProjects,
    switchProject,
    setCurrentProject,
    markPickerStarted,
  } = useProjectStore();
  // toggleTeamBuilder (useAppStore) removed — team-builder auto-open hidden (WO #47).
  const pickerMode = useProjectStore((s) => s.pickerMode);

  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && projects.length === 0 && !loading) fetchProjects();
  }, [isOpen, projects.length, loading, fetchProjects]);

  // Pre-select the current project when entering stored-confirm mode; reset
  // selection when mode flips to first-boot-prompt (no default highlight).
  useEffect(() => {
    if (!isOpen) return;
    if (pickerMode === 'stored-confirm' && activeProject?.id) {
      setSelectedProjectId(activeProject.id);
      setExpanded(false);
    } else if (pickerMode === 'first-boot-prompt') {
      setSelectedProjectId(null);
      setExpanded(true);
    }
    setSwitchError(null);
  }, [isOpen, pickerMode, activeProject?.id]);

  if (!isOpen) return null;

  const handleStart = async () => {
    if (pickerMode === 'create-cta') return; // no Start in CTA mode
    if (selectedProjectId === null) return; // disabled state
    setSwitchError(null);

    // First-pick path (state is 'unset', mapped to 'first-boot-prompt'):
    // cloud writeback only, no PTY work. Safe because Ship F-bis's
    // boot-ordering gate prevents PTYs from spawning before state flips
    // to 'stored'. After setCurrentProject succeeds, fetchActiveProject
    // inside it flips state to 'stored', useMail's gate flips, Phase 5
    // fires and reconciles the team into appStore.agents — all in the
    // same tick the picker closes. ('create-cta' early-returns at the
    // top of this handler — no projects to pick.)
    // The explicit user "go". The project is already RUNNING cloud-side
    // (POSTing 'start' 400s — you can't start what's running). So instead
    // of mutating the cloud, tell main to re-read the state the backend
    // already has (current-project + lifecycle) and feed the spawn-
    // orchestrator, which instantiates the team. Best-effort; the
    // orchestrator's result is visible as the panes populating, and the
    // main-process [SpawnOrch] log is the diagnostic if they don't.
    const triggerStart = async (): Promise<boolean> => {
      await window.electronAPI.reseedLifecycle();
      return true;
    };

    if (pickerMode === 'first-boot-prompt') {
      setStarting(true);
      const success = await setCurrentProject(selectedProjectId);
      if (!success) {
        setStarting(false);
        setSwitchError("Couldn't set your current project. Please try again.");
        return;
      }
      const started = await triggerStart();
      setStarting(false);
      if (started) {
        markPickerStarted();
        onClose();
        // ACP READ-ONLY (Jon D1, WO #47): team curation is web-only — do NOT auto-open
        // the Team Builder after start. Re-enable: restore the useAppStore import +
        // toggleTeamBuilder destructure (top) and uncomment the call below.
        // toggleTeamBuilder();
      }
      return;
    }

    // Confirming the already-stored current project (the common case:
    // one startup project, already selected). NOT a no-op anymore — this
    // is the user's explicit Start: fire the lifecycle so the team spawns.
    if (selectedProjectId === activeProject?.id) {
      setStarting(true);
      const started = await triggerStart();
      setStarting(false);
      if (started) {
        markPickerStarted();
        onClose();
      }
      return;
    }

    // Stored mode + different project = actual switch. Wave C/2 lands
    // this as an atomic flow: store.switchProject → electronAPI.switchProject
    // → main PUTs current-project + writes boot-overlay flag → app.relaunch.
    // The renderer paints the overlay via the pre-mount HTML before this
    // promise even resolves on success (process exits ~250ms after PUT).
    // On error (cloud PUT failed, network unreachable, validation): no
    // relaunch, surface the message inline. No more fail-loud stub.
    setStarting(true);
    try {
      const success = await switchProject(selectedProjectId);
      setStarting(false);
      if (success) {
        // Picker close is mostly cosmetic — app is restarting within
        // ~250ms. Marking started preserves any picker-state read by
        // the next-boot flow if we ever route through this surface
        // again pre-relaunch.
        markPickerStarted();
        onClose();
      }
    } catch (err) {
      setStarting(false);
      setSwitchError(`Couldn't switch projects: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const headerLabel =
    pickerMode === 'stored-confirm' ? 'Your current project'
    : pickerMode === 'first-boot-prompt' ? 'Pick a project to continue'
    : 'Create your first project';

  const startDisabled = starting || (pickerMode !== 'create-cta' && selectedProjectId === null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[28rem] max-h-[80vh] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-semibold text-slate-200">{headerLabel}</span>
          </div>
          {pickerMode === 'first-boot-prompt' && (
            <p className="text-xs text-slate-400 mt-1">
              Choose one below to set it as your current project.
            </p>
          )}
          {switchError && (
            <div className="mt-2 px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/30">
              <p className="text-xs text-amber-300">{switchError}</p>
            </div>
          )}
        </div>

        {/* Body */}
        {pickerMode === 'create-cta' ? (
          <CreateCtaBody />
        ) : pickerMode === 'stored-confirm' && !expanded ? (
          <StoredConfirmCompactBody project={activeProject} />
        ) : (
          <ListBody
            projects={projects}
            loading={loading}
            selectedProjectId={selectedProjectId}
            onSelect={setSelectedProjectId}
            activeProjectId={activeProject?.id}
          />
        )}

        {pickerMode === 'stored-confirm' && !expanded && (
          <p className="px-6 pb-3 -mt-1 text-[11px] leading-relaxed text-slate-500 text-center">
            ACP launches this startup project every time you start it.
            Switching projects is coming soon — for now, change your
            startup project on idealvibe.online and restart ACP.
          </p>
        )}

        {/* Footer */}
        {pickerMode === 'create-cta' || projects.length === 0 ? (
          <CreateCtaFooter />
        ) : (
          <div className="border-t border-slate-700 px-3 py-2.5 flex items-center gap-2">
            {/* Stored-confirm + collapsed → [Pick another] toggle.
                Otherwise → "Manage on idealvibe.online" link as side affordance. */}
            {pickerMode === 'stored-confirm' && !expanded ? (
              <span
                className="flex-1 flex items-center gap-1.5 text-xs text-slate-600 px-2 py-1.5 cursor-not-allowed select-none"
                title="Coming soon. ACP launches your startup project on every start — restart to change it."
              >
                <ChevronDown className="w-3.5 h-3.5 opacity-40" />
                Pick another — coming soon
              </span>
            ) : (
              <a
                href="https://idealvibe.online/dashboard/vibe-projects"
                target="_blank"
                rel="noreferrer"
                className="flex-1 flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 px-2 py-1.5"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Manage projects on idealvibe.online
              </a>
            )}
            {pickerMode === 'stored-confirm' && expanded && (
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="text-xs text-slate-500 hover:text-slate-300 px-2 py-1.5 flex items-center gap-1"
              >
                <ChevronUp className="w-3.5 h-3.5" />
                Collapse
              </button>
            )}
            <button
              type="button"
              onClick={handleStart}
              disabled={startDisabled}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {starting ? 'Starting...' : 'Start'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Body sub-components ---

function StoredConfirmCompactBody({ project }: { project: Project | null }) {
  if (!project) {
    return (
      <div className="flex-1 px-4 py-6 text-sm text-slate-500 text-center">
        No current project on file.
      </div>
    );
  }
  return (
    <div className="flex-1 px-4 py-5">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
        <span className="text-base font-semibold text-slate-100 truncate">{project.name}</span>
        <Check className="w-4 h-4 text-emerald-400 ml-auto flex-shrink-0" />
      </div>
      <AttributePills project={project} />
      {project.updated_at && (
        <p className="text-[11px] text-slate-500 mt-2 ml-4">
          last set {formatDate(project.updated_at)}
        </p>
      )}
      {project.goal_summary && (
        <p className="text-xs text-slate-400 mt-2 ml-4 line-clamp-2">{project.goal_summary}</p>
      )}
    </div>
  );
}

function ListBody({
  projects,
  loading,
  selectedProjectId,
  onSelect,
  activeProjectId,
}: {
  projects: Project[];
  loading: boolean;
  selectedProjectId: number | null;
  onSelect: (id: number) => void;
  activeProjectId?: number;
}) {
  // Sort current project to the top when present
  const sorted = useMemo(() => {
    if (!activeProjectId) return projects;
    const current = projects.find((p) => p.id === activeProjectId);
    if (!current) return projects;
    return [current, ...projects.filter((p) => p.id !== activeProjectId)];
  }, [projects, activeProjectId]);

  if (loading && projects.length === 0) {
    return (
      <div className="flex-1 px-4 py-6 text-sm text-slate-500 text-center">Loading projects…</div>
    );
  }
  if (sorted.length === 0) {
    return <CreateCtaBody />;
  }
  return (
    <div className="flex-1 overflow-y-auto p-2">
      {sorted.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          isSelected={selectedProjectId === project.id}
          isCurrent={activeProjectId === project.id}
          onSelect={() => onSelect(project.id)}
        />
      ))}
    </div>
  );
}

function CreateCtaBody() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-center">
      <FolderOpen className="w-10 h-10 text-slate-600 mb-3" />
      <p className="text-sm text-slate-300 mb-2">You don't have any projects yet.</p>
      <p className="text-xs text-slate-500 mb-4">
        Create your first project on idealvibe.online to get started.
      </p>
    </div>
  );
}

function CreateCtaFooter() {
  return (
    <div className="border-t border-slate-700 px-3 py-2.5 flex items-center justify-center">
      <a
        href="https://idealvibe.online/dashboard/vibe-projects"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium"
      >
        <ExternalLink className="w-4 h-4" />
        Open idealvibe.online to create
      </a>
    </div>
  );
}

// --- Row + pills ---

function ProjectRow({
  project,
  isSelected,
  isCurrent,
  onSelect,
}: {
  project: Project;
  isSelected: boolean;
  isCurrent: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left p-2.5 rounded transition-colors ${
        isSelected ? 'bg-slate-800 ring-1 ring-emerald-500/50' : 'hover:bg-slate-800/60'
      }`}
    >
      <div className="flex items-center gap-2">
        <div
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            isCurrent ? 'bg-emerald-400' : 'bg-slate-600'
          }`}
        />
        <span className="text-sm font-medium text-slate-200 truncate">{project.name}</span>
        {isCurrent && (
          <span className="text-[9px] uppercase tracking-wider text-emerald-400 font-semibold flex-shrink-0">
            current
          </span>
        )}
        {isSelected && <Check className="w-3.5 h-3.5 text-emerald-400 ml-auto flex-shrink-0" />}
      </div>
      <div className="ml-4 mt-1">
        <AttributePills project={project} />
      </div>
    </button>
  );
}

function AttributePills({ project }: { project: Project }) {
  // BAPert chrome: "<X> · <target_stack> · <auth_method> · <runtime>"
  // Render "—" placeholder for null fields per Wave B settings panel spec
  // (visibility > editability > hiding). Click [⚙ settings] to fill in.
  const stack = project.target_stack ?? '—';
  const auth = project.auth_method ?? '—';
  const runtime = project.runtime ?? '—';
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
      <span className="truncate">{stack}</span>
      <span className="text-slate-700">·</span>
      <span className="truncate">{auth}</span>
      <span className="text-slate-700">·</span>
      <span className="truncate">{runtime}</span>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
