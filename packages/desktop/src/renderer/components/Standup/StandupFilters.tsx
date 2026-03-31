import { X } from 'lucide-react';
import { useStandupStore } from '../../stores/standupStore';
import { StandupEventType } from '@shared/types';

const AGENTS = ['BAPert', 'DotNetPert', 'NextPert', 'NextPertTwo', 'QAPert'];

const EVENT_TYPES: { value: StandupEventType; label: string }[] = [
  { value: 'completed', label: 'Completed' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'started', label: 'Started' },
  { value: 'review_requested', label: 'Review Req.' },
  { value: 'review_passed', label: 'Approved' },
  { value: 'review_failed', label: 'Changes Req.' },
  { value: 'milestone_done', label: 'Milestone' },
];

const TIME_RANGES = [
  { value: 'today' as const, label: 'Today' },
  { value: '24h' as const, label: '24h' },
  { value: '7d' as const, label: '7 days' },
];

export function StandupFilters() {
  const { filters, setFilters } = useStandupStore();

  const toggleAgent = (agent: string) => {
    const current = filters.agents;
    const newAgents = current.includes(agent)
      ? current.filter((a) => a !== agent)
      : [...current, agent];
    setFilters({ agents: newAgents });
  };

  const toggleEventType = (type: StandupEventType) => {
    const current = filters.eventTypes;
    const newTypes = current.includes(type)
      ? current.filter((t) => t !== type)
      : [...current, type];
    setFilters({ eventTypes: newTypes });
  };

  const hasFilters = filters.agents.length > 0 || filters.eventTypes.length > 0;

  const clearFilters = () => {
    setFilters({ agents: [], eventTypes: [] });
  };

  return (
    <div className="p-3 border-b border-slate-700 space-y-3">
      {/* Time Range */}
      <div className="flex items-center gap-2" role="group" aria-label="Time range filter">
        <span className="text-xs text-slate-500 w-12">Time:</span>
        <div className="flex gap-1">
          {TIME_RANGES.map((range) => (
            <button
              key={range.value}
              onClick={() => setFilters({ since: range.value })}
              aria-pressed={filters.since === range.value}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                filters.since === range.value
                  ? 'bg-vibe-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      {/* Agent Filter */}
      <div className="flex items-start gap-2" role="group" aria-label="Agent filter">
        <span className="text-xs text-slate-500 w-12 pt-1">Agent:</span>
        <div className="flex flex-wrap gap-1">
          {AGENTS.map((agent) => (
            <button
              key={agent}
              onClick={() => toggleAgent(agent)}
              aria-pressed={filters.agents.includes(agent)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                filters.agents.includes(agent)
                  ? 'bg-vibe-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {agent}
            </button>
          ))}
        </div>
      </div>

      {/* Event Type Filter */}
      <div className="flex items-start gap-2" role="group" aria-label="Event type filter">
        <span className="text-xs text-slate-500 w-12 pt-1">Type:</span>
        <div className="flex flex-wrap gap-1">
          {EVENT_TYPES.map((type) => (
            <button
              key={type.value}
              onClick={() => toggleEventType(type.value)}
              aria-pressed={filters.eventTypes.includes(type.value)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                filters.eventTypes.includes(type.value)
                  ? 'bg-vibe-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {type.label}
            </button>
          ))}
        </div>
      </div>

      {/* Clear Filters */}
      {hasFilters && (
        <div className="flex justify-end">
          <button
            onClick={clearFilters}
            className="flex items-center gap-1 px-2 py-1 text-xs text-slate-400 hover:text-white transition-colors"
            aria-label="Clear all filters"
          >
            <X className="w-3 h-3" />
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
