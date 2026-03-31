import { X, CheckCheck, RefreshCw } from 'lucide-react';
import { useStandupStore, useFilteredEntries } from '../../stores/standupStore';
import { StandupFilters } from './StandupFilters';
import { StandupEntryCard } from './StandupEntry';

interface StandupSidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function StandupSidebar({ isOpen, onClose }: StandupSidebarProps) {
  const { loading, error, unreadCount, markAsReviewed } = useStandupStore();
  const filteredEntries = useFilteredEntries();

  if (!isOpen) return null;

  return (
    <div className="w-80 h-full bg-[#0d1929] border-l border-[#2d4a6b] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-white">Standup</h2>
          {unreadCount > 0 && (
            <span className="px-1.5 py-0.5 text-xs font-bold bg-vibe-600 text-white rounded">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={markAsReviewed}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
            title="Mark all as reviewed"
            aria-label="Mark all standup entries as reviewed"
          >
            <CheckCheck className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
            title="Close standup sidebar"
            aria-label="Close standup sidebar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filters */}
      <StandupFilters />

      {/* Entries List */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center p-8">
            <RefreshCw className="w-6 h-6 text-slate-500 animate-spin" />
          </div>
        )}

        {error && (
          <div className="p-4 text-center text-red-400 text-sm">
            {error}
          </div>
        )}

        {!loading && !error && filteredEntries.length === 0 && (
          <div className="p-8 text-center text-slate-500 text-sm">
            No standup entries match your filters
          </div>
        )}

        {!loading && !error && filteredEntries.length > 0 && (
          <div className="relative">
            {/* Timeline vertical line */}
            <div className="absolute left-[27px] top-0 bottom-0 w-px bg-slate-700" />

            {filteredEntries.map((entry) => (
              <div key={entry.id} className="relative">
                {/* Timeline dot */}
                <div className="absolute left-[23px] top-[22px] w-2 h-2 rounded-full bg-slate-600 ring-2 ring-slate-900 z-10" />
                <StandupEntryCard
                  entry={entry}
                  onTaskClick={(taskId) => {
                    // TODO: Open kanban task
                    console.log('Open task:', taskId);
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer Stats */}
      <div className="p-3 border-t border-slate-700 text-xs text-slate-500">
        {filteredEntries.length} entries shown
      </div>
    </div>
  );
}
