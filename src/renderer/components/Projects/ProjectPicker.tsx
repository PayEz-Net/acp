import { useEffect, useState } from 'react';
import { FolderOpen, Plus, Check, Archive, CheckCircle } from 'lucide-react';
import { useProjectStore, Project } from '../../stores/projectStore';

interface ProjectPickerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ProjectPicker({ isOpen, onClose }: ProjectPickerProps) {
  const { projects, activeProject, loading, fetchProjects, switchProject, createProject } = useProjectStore();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState<number | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState<number | null>(null);

  useEffect(() => {
    if (isOpen) fetchProjects();
  }, [isOpen, fetchProjects]);

  if (!isOpen) return null;

  const handleSwitch = async (projectId: number) => {
    // If switching away from active project, confirm first
    if (activeProject && activeProject.id !== projectId && confirmSwitch !== projectId) {
      setConfirmSwitch(projectId);
      return;
    }
    setSwitching(projectId);
    setConfirmSwitch(null);
    const success = await switchProject(projectId);
    setSwitching(null);
    if (success) onClose();
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    const project = await createProject(newName.trim(), newDesc.trim() || undefined);
    setCreating(false);
    if (project) {
      setNewName('');
      setNewDesc('');
      setShowCreate(false);
      // Auto-switch to newly created project
      await handleSwitch(project.id);
    }
  };

  const statusIcon = (status: string) => {
    if (status === 'archived') return <Archive className="w-3 h-3 text-slate-500" />;
    if (status === 'completed') return <CheckCircle className="w-3 h-3 text-slate-500" />;
    return null;
  };

  const activeProjects = projects.filter(p => p.status === 'active');
  const otherProjects = projects.filter(p => p.status !== 'active');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-96 max-h-[70vh] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-semibold text-slate-200">Select Project</span>
            </div>
            {activeProject && (
              <button
                onClick={onClose}
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* Project list */}
        <div className="flex-1 overflow-y-auto p-2">
          {loading && projects.length === 0 ? (
            <div className="p-4 text-sm text-slate-500 text-center">Loading...</div>
          ) : (
            <>
              {activeProjects.map(project => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  isActive={activeProject?.id === project.id}
                  isSwitching={switching === project.id}
                  showConfirm={confirmSwitch === project.id}
                  onSelect={() => handleSwitch(project.id)}
                  onCancelConfirm={() => setConfirmSwitch(null)}
                  statusIcon={statusIcon(project.status)}
                />
              ))}
              {otherProjects.length > 0 && (
                <>
                  <div className="text-[10px] font-medium text-slate-600 uppercase tracking-wider px-2 py-1 mt-2">
                    Archived / Completed
                  </div>
                  {otherProjects.map(project => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      isActive={activeProject?.id === project.id}
                      isSwitching={switching === project.id}
                      showConfirm={confirmSwitch === project.id}
                      onSelect={() => handleSwitch(project.id)}
                      onCancelConfirm={() => setConfirmSwitch(null)}
                      statusIcon={statusIcon(project.status)}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </div>

        {/* Create new */}
        <div className="border-t border-slate-700 p-3">
          {!showCreate ? (
            <button
              onClick={() => setShowCreate(true)}
              className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded border border-dashed border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-500 text-sm transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Project
            </button>
          ) : (
            <div className="space-y-2">
              <input
                type="text"
                placeholder="Project name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowCreate(false); }}
              />
              <input
                type="text"
                placeholder="Description (optional)"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowCreate(false); }}
              />
              <div className="flex gap-1">
                <button
                  onClick={handleCreate}
                  disabled={creating || !newName.trim()}
                  className="flex-1 text-xs py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-colors"
                >
                  {creating ? 'Creating...' : 'Create & Switch'}
                </button>
                <button
                  onClick={() => { setShowCreate(false); setNewName(''); setNewDesc(''); }}
                  className="text-xs py-1.5 px-3 rounded bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectRow({
  project,
  isActive,
  isSwitching,
  showConfirm,
  onSelect,
  onCancelConfirm,
  statusIcon,
}: {
  project: Project;
  isActive: boolean;
  isSwitching: boolean;
  showConfirm: boolean;
  onSelect: () => void;
  onCancelConfirm: () => void;
  statusIcon: React.ReactNode;
}) {
  return (
    <div className="rounded hover:bg-slate-800 transition-colors">
      <button
        onClick={onSelect}
        disabled={isSwitching}
        className="w-full text-left p-2.5 rounded transition-colors disabled:opacity-50"
      >
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isActive ? 'bg-emerald-400' : 'bg-slate-600'}`} />
          <span className="text-sm font-medium text-slate-200 truncate">{project.name}</span>
          {isActive && <Check className="w-3.5 h-3.5 text-emerald-400 ml-auto flex-shrink-0" />}
          {statusIcon}
        </div>
        {project.description && (
          <p className="text-xs text-slate-500 mt-0.5 ml-4 truncate">{project.description}</p>
        )}
        <div className="text-[10px] text-slate-600 mt-0.5 ml-4">
          {project.status} · {new Date(project.created_at).toLocaleDateString()}
        </div>
      </button>
      {showConfirm && (
        <div className="px-2.5 pb-2.5 flex gap-1">
          <button
            onClick={onSelect}
            disabled={isSwitching}
            className="flex-1 text-xs py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-colors"
          >
            {isSwitching ? 'Switching...' : 'Confirm switch'}
          </button>
          <button
            onClick={onCancelConfirm}
            className="text-xs py-1 px-2 rounded bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
