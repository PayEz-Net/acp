import { useEffect } from 'react';
import { Settings, X, ExternalLink, Crown } from 'lucide-react';
import { useProjectStore, Project, ProjectTeamMember } from '../../stores/projectStore';

interface ProjectSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

// Read-only settings panel per Wave B workorder §4.2 + vision doc
// "How humans understand projects" (settings panel as load-bearing UX).
// Drawer slides from right, scoped to the current project. Edits route
// through "Edit on idealvibe.online" deeplink — ACP is a viewer in
// Phase 1 (idealvibe.online is the canonical edit surface).
//
// Sections:
//   - Identity: name, description, goal_summary, owner, id, timestamps
//   - Stack & Runtime: target_stack, runtime, auth_method, repo_path
//   - Wave A.1 Detail: app_type, signin_choice, runtime_choice, repo_layout,
//     stack_topology, compliance, advisor_output (read-only blob preview)
//   - Team: per-project agent table with role, runtime override, work_dir
//     override, position_hint, is_lead. Inherit values shown in italic
//     when overrides are null.
//
// Empty fields render "—" placeholder per Wave B settings panel spec
// (visibility > editability > hiding). Click Edit-on-idealvibe to fill in.
export function ProjectSettingsPanel({ isOpen, onClose }: ProjectSettingsPanelProps) {
  const { activeProject, currentProjectTeam, loadingTeam, fetchCurrentProjectTeam } =
    useProjectStore();

  useEffect(() => {
    if (isOpen && activeProject?.id) {
      fetchCurrentProjectTeam(activeProject.id);
    }
  }, [isOpen, activeProject?.id, fetchCurrentProjectTeam]);

  // Escape closes the drawer (read-only, no commit needed)
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const editUrl = activeProject
    ? `https://idealvibe.online/dashboard/vibe-projects/${activeProject.id}`
    : 'https://idealvibe.online/dashboard/vibe-projects';

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer */}
      <div className="fixed top-0 right-0 z-50 h-full w-[28rem] bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-semibold text-slate-200">Project Settings</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-200"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
          {!activeProject ? (
            <div className="text-sm text-slate-500 text-center py-10">
              No project selected.
            </div>
          ) : (
            <>
              <IdentitySection project={activeProject} />
              <StackRuntimeSection project={activeProject} />
              <WaveA1DetailSection project={activeProject} />
              <TeamSection team={currentProjectTeam} loading={loadingTeam} />
            </>
          )}
        </div>

        {/* Footer — edit-on-idealvibe deeplink */}
        <div className="border-t border-slate-700 px-4 py-3">
          <a
            href={editUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-sm text-emerald-400 hover:text-emerald-300"
          >
            <ExternalLink className="w-4 h-4" />
            Edit on idealvibe.online
          </a>
          <p className="text-[11px] text-slate-500 mt-1">
            ACP shows project state read-only. Edits propagate back within 60s.
          </p>
        </div>
      </div>
    </>
  );
}

// --- Sections ---

function IdentitySection({ project }: { project: Project }) {
  return (
    <Section title="Identity">
      <Row label="Name" value={project.name} />
      <Row label="Description" value={project.description ?? null} />
      <Row label="Goal" value={project.goal_summary ?? null} multiline />
      <Row label="ID" value={String(project.id)} mono />
      <Row label="Owner" value={project.owner_user_id ? `user_${project.owner_user_id}` : null} mono />
      <Row label="Created" value={formatDate(project.created_at)} />
      <Row label="Last edited" value={formatDate(project.updated_at)} />
    </Section>
  );
}

function StackRuntimeSection({ project }: { project: Project }) {
  return (
    <Section title="Stack & Runtime">
      <Row label="Target stack" value={project.target_stack ?? null} />
      <Row label="Runtime (project default)" value={project.runtime ?? null} />
      <Row label="Auth method" value={project.auth_method ?? null} />
      <Row label="Repo path" value={project.repo_path ?? null} mono />
    </Section>
  );
}

function WaveA1DetailSection({ project }: { project: Project }) {
  // Wave A.1 enriched detail. Empty when all 7 fields are null — common
  // for Jon's pre-Wave-A.1 projects until setup-interview pivots to PUT.
  const allEmpty =
    project.app_type === null &&
    project.signin_choice === null &&
    project.runtime_choice === null &&
    project.repo_layout === null &&
    project.stack_topology === null &&
    !project.compliance &&
    !project.advisor_output;
  return (
    <Section title="Detail" subtitle={allEmpty ? 'Not yet configured — fill in via Edit on idealvibe.online' : undefined}>
      <Row label="App type" value={project.app_type ?? null} />
      <Row label="Sign-in choice" value={project.signin_choice ?? null} />
      <Row label="Runtime choice (user team)" value={project.runtime_choice ?? null} />
      <Row label="Repo layout" value={project.repo_layout ?? null} />
      <Row label="Stack topology" value={project.stack_topology ?? null} />
      <Row
        label="Compliance"
        value={
          Array.isArray(project.compliance) && project.compliance.length > 0
            ? project.compliance.map((c) => String(c)).join(', ')
            : null
        }
      />
      <Row
        label="Advisor output"
        value={project.advisor_output ? '(present — see idealvibe.online)' : null}
      />
    </Section>
  );
}

function TeamSection({ team, loading }: { team: ProjectTeamMember[]; loading: boolean }) {
  if (loading && team.length === 0) {
    return (
      <Section title="Team">
        <p className="text-xs text-slate-500">Loading team…</p>
      </Section>
    );
  }
  if (team.length === 0) {
    return (
      <Section title="Team">
        <p className="text-xs text-slate-500">No team members.</p>
      </Section>
    );
  }
  return (
    <Section title={`Team (${team.length})`}>
      <div className="space-y-2.5">
        {team.map((m) => (
          <div
            key={m.agent_id}
            className="rounded border border-slate-800 bg-slate-950/40 px-3 py-2.5"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium text-slate-100">{m.agent_name}</span>
              {m.is_lead && (
                <span className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider text-amber-300 font-semibold">
                  <Crown className="w-3 h-3" /> lead
                </span>
              )}
            </div>
            {m.agent_display_name && (
              <p className="text-[11px] text-slate-500 mb-1.5">{m.agent_display_name}</p>
            )}
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
              <TeamCell
                label="Role"
                value={m.role}
                inheritFrom={m.role === null ? m.canonical_role : null}
              />
              <TeamCell label="Position" value={m.position_hint} inheritFrom={m.position_hint === null ? 'auto' : null} />
              <TeamCell label="Runtime" value={m.runtime_override} inheritFrom={m.runtime_override === null ? 'project default' : null} />
              <TeamCell label="WorkDir" value={m.work_dir_override} inheritFrom={m.work_dir_override === null ? 'project repo' : null} mono />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// --- Helpers ---

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">{title}</h3>
      {subtitle && <p className="text-[11px] text-slate-500 mb-2 -mt-1">{subtitle}</p>}
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  multiline,
  mono,
}: {
  label: string;
  value: string | null;
  multiline?: boolean;
  mono?: boolean;
}) {
  return (
    <div className={multiline ? 'py-1' : 'flex items-baseline gap-2 py-1'}>
      <span className={`text-[11px] text-slate-500 ${multiline ? 'block mb-0.5' : 'flex-shrink-0 w-32'}`}>
        {label}
      </span>
      <span
        className={`text-xs ${value ? 'text-slate-200' : 'text-slate-600'} ${mono ? 'font-mono' : ''} ${multiline ? 'block whitespace-pre-line' : 'flex-1 truncate'}`}
        title={value ?? '—'}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

function TeamCell({
  label,
  value,
  inheritFrom,
  mono,
}: {
  label: string;
  value: string | null;
  inheritFrom: string | null;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <span className="text-slate-600 mr-1">{label}:</span>
      {value !== null ? (
        <span className={`text-slate-300 ${mono ? 'font-mono' : ''}`}>{value}</span>
      ) : (
        <span className="text-slate-600 italic">inherits {inheritFrom ?? '—'}</span>
      )}
    </div>
  );
}

function formatDate(iso: string | undefined | null): string | null {
  if (!iso) return null;
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
