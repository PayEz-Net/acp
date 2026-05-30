import { useEffect, useMemo, useRef } from 'react';
import { Search, X, Library } from 'lucide-react';
import { useSpecialistStore, SpecialistAgent } from '../../stores/specialistStore';
import { useProjectStore } from '../../stores/projectStore';
import { AgentCatalogCard } from './AgentCatalogCard';
import { TeamRosterList } from './TeamRosterList';

interface TeamBuilderModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TeamBuilderModal({ isOpen, onClose }: TeamBuilderModalProps) {
  const {
    catalog,
    roster,
    loading,
    error,
    searchQuery,
    filterCategory,
    setSearchQuery,
    setFilterCategory,
    fetchCatalog,
    engageAgent,
    disengageAgent,
    reorderRoster,
    saveRosterOrder,
    addToProjectTeam,
    removeFromProjectTeam,
  } = useSpecialistStore();

  const activeProject = useProjectStore((s) => s.activeProject);
  const modalRef = useRef<HTMLDivElement>(null);

  // Load catalog on open
  useEffect(() => {
    if (isOpen) {
      fetchCatalog();
    }
  }, [isOpen, fetchCatalog]);

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === modalRef.current) {
      onClose();
    }
  };

  // Derive categories from catalog
  const categories = useMemo(() => {
    const set = new Set<string>();
    catalog.forEach((a) => {
      if (a.agentType) set.add(a.agentType);
    });
    return Array.from(set).sort();
  }, [catalog]);

  // Filtered catalog
  const filteredCatalog = useMemo(() => {
    let result = catalog;
    if (filterCategory) {
      result = result.filter((a) => a.agentType === filterCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.displayName?.toLowerCase().includes(q) ?? false) ||
          (a.role?.toLowerCase().includes(q) ?? false)
      );
    }
    return result;
  }, [catalog, filterCategory, searchQuery]);

  const engagedIds = useMemo(() => new Set(roster.map((r) => r.id)), [roster]);

  const handleEngage = async (agent: SpecialistAgent) => {
    engageAgent(agent);
    if (activeProject) {
      await addToProjectTeam(activeProject.id, agent.id);
    }
  };

  const handleRemove = async (agentId: number) => {
    disengageAgent(agentId);
    if (activeProject) {
      await removeFromProjectTeam(activeProject.id, agentId);
    }
  };

  const handleSave = async () => {
    if (activeProject) {
      await saveRosterOrder(activeProject.id);
    }
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="team-builder-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="w-[90vw] h-[85vh] max-w-6xl bg-slate-950 border border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Library className="w-5 h-5 text-emerald-400" />
            <h2 id="team-builder-title" className="text-sm font-semibold text-slate-200">
              Specialist Library
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-500 hover:text-slate-200 transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body: 3-pane layout */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left: Search / Filters */}
          <div className="w-64 flex-shrink-0 border-r border-slate-700 flex flex-col bg-slate-900/50">
            <div className="p-3 space-y-3">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search specialists…"
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50"
                />
              </div>

              {/* Category filters */}
              <div>
                <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
                  Filter by type
                </p>
                <div className="space-y-0.5">
                  <button
                    onClick={() => setFilterCategory(null)}
                    className={`w-full text-left text-xs px-2 py-1 rounded transition-colors ${
                      filterCategory === null
                        ? 'bg-emerald-600/20 text-emerald-400'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    All
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setFilterCategory(cat)}
                      className={`w-full text-left text-xs px-2 py-1 rounded transition-colors ${
                        filterCategory === cat
                          ? 'bg-emerald-600/20 text-emerald-400'
                          : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Center: Catalog */}
          <div className="flex-1 min-w-0 flex flex-col bg-slate-950">
            <div className="px-4 py-2 border-b border-slate-700 flex items-center justify-between flex-shrink-0">
              <p className="text-xs text-slate-400">
                Catalog <span className="text-slate-600">·</span>{' '}
                <span className="text-slate-500">{filteredCatalog.length}</span>
              </p>
              {loading && <span className="text-[10px] text-slate-500 animate-pulse">Loading…</span>}
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              {error && (
                <div className="p-4 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded">
                  {error}
                </div>
              )}

              {filteredCatalog.length === 0 && !loading && !error && (
                <div className="h-full flex items-center justify-center text-xs text-slate-500">
                  No specialists match your search.
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {filteredCatalog.map((agent) => (
                  <AgentCatalogCard
                    key={agent.id}
                    agent={agent}
                    isEngaged={engagedIds.has(agent.id)}
                    onEngage={handleEngage}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Right: Specialist Bench */}
          <div className="w-72 flex-shrink-0 border-l border-slate-700 flex flex-col bg-slate-900/50">
            <TeamRosterList
              roster={roster}
              onReorder={reorderRoster}
              onRemove={handleRemove}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-700 px-5 py-3 flex items-center justify-between flex-shrink-0">
          <p className="text-[11px] text-slate-500">
            {activeProject
              ? `Curating team for ${activeProject.name}`
              : 'Select a project to curate your team'}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
            >
              Save Bench
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
