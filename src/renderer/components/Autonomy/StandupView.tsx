import { useEffect } from 'react';
import { useAutonomyStore } from '../../stores/autonomyStore';
import { useAppStore } from '../../stores/appStore';
import { ClipboardList } from 'lucide-react';

const EVENT_COLORS: Record<string, string> = {
  completed: 'text-green-400',
  started: 'text-blue-400',
  blocked: 'text-red-400',
  review_requested: 'text-amber-400',
  review_passed: 'text-green-400',
  review_failed: 'text-red-400',
  milestone_done: 'text-violet-400',
};

const EVENT_ICONS: Record<string, string> = {
  completed: '✓',
  started: '▶',
  blocked: '✕',
  review_requested: '⧖',
  review_passed: '✓✓',
  review_failed: '✕✕',
  milestone_done: '★',
};

export function StandupView() {
  const { standupEntries, filters, loading, fetchStandup, setFilters } = useAutonomyStore();
  const { backendAvailable, agents } = useAppStore();

  useEffect(() => {
    if (!backendAvailable) return;
    fetchStandup();
  }, [backendAvailable, fetchStandup]);

  const agentNames = agents.map(a => a.name);

  const filteredEntries = standupEntries.filter((entry) => {
    if (filters.agents.length > 0 && !filters.agents.includes(entry.agent)) return false;
    if (filters.eventTypes.length > 0 && !filters.eventTypes.includes(entry.event_type)) return false;
    return true;
  });

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-slate-400 uppercase flex items-center gap-1">
          <ClipboardList className="w-3 h-3" /> Standup Log
        </h3>
        <span className="text-xs text-slate-500">{filteredEntries.length} entries</span>
      </div>

      {/* Filters */}
      <div className="flex gap-1 mb-2 flex-wrap">
        {agentNames.map((name) => (
          <button
            key={name}
            onClick={() => {
              const current = filters.agents;
              setFilters({
                agents: current.includes(name)
                  ? current.filter(a => a !== name)
                  : [...current, name],
              });
            }}
            className={`px-2 py-0.5 rounded text-xs transition-colors ${
              filters.agents.length === 0 || filters.agents.includes(name)
                ? 'bg-slate-700 text-slate-200'
                : 'bg-slate-800 text-slate-500'
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      {/* Entries */}
      {loading ? (
        <div className="text-xs text-slate-500 text-center py-2">Loading...</div>
      ) : filteredEntries.length === 0 ? (
        <div className="text-xs text-slate-500 text-center py-2">No standup entries</div>
      ) : (
        <div className="space-y-1 max-h-60 overflow-y-auto">
          {filteredEntries.slice(0, 50).map((entry) => (
            <div key={entry.id} className="bg-slate-800 rounded p-2 text-xs">
              <div className="flex items-center gap-1">
                <span className={EVENT_COLORS[entry.event_type] || 'text-slate-400'}>
                  {EVENT_ICONS[entry.event_type] || '•'}
                </span>
                <span className="text-slate-300 font-medium">{entry.agent}</span>
                <span className="text-slate-500 ml-auto">
                  {new Date(entry.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className="text-slate-400 mt-0.5">{entry.summary}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
