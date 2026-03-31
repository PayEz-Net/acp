import { useEffect, useCallback } from 'react';
import { useStandupStore, useFilteredEntries } from '../../stores/standupStore';
import { useAppStore } from '../../stores/appStore';
import { ClipboardList, Play, Clock, CheckCheck, Users, History } from 'lucide-react';

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
  completed: '\u2713',
  started: '\u25B6',
  blocked: '\u2715',
  review_requested: '\u29D6',
  review_passed: '\u2713\u2713',
  review_failed: '\u2715\u2715',
  milestone_done: '\u2605',
};

export function StandupView() {
  const {
    filters, loading, error, unreadCount, standupInProgress,
    schedule, meetingNotes,
    fetchEntries, setFilters, markAsReviewed, triggerStandup, setSchedule,
  } = useStandupStore();
  const filteredEntries = useFilteredEntries();
  const { backendAvailable, agents } = useAppStore();

  const agentNames = agents.map(a => a.name);

  // Fetch entries on mount and mark as reviewed
  useEffect(() => {
    if (!backendAvailable) return;
    fetchEntries();
  }, [backendAvailable, fetchEntries]);

  // Mark as reviewed when tab opens
  useEffect(() => {
    if (unreadCount > 0) {
      markAsReviewed();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRunNow = useCallback(async () => {
    await triggerStandup();
    // Refresh entries after triggering
    setTimeout(() => fetchEntries(), 2000);
  }, [triggerStandup, fetchEntries]);

  const handleScheduleToggle = useCallback(() => {
    setSchedule({ ...schedule, enabled: !schedule.enabled });
  }, [schedule, setSchedule]);

  const handleTimeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSchedule({ ...schedule, time: e.target.value });
  }, [schedule, setSchedule]);

  return (
    <div className="bg-slate-900 border-t border-slate-700 max-h-80 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 shrink-0">
        <h3 className="text-xs font-semibold text-slate-400 uppercase flex items-center gap-1">
          <ClipboardList className="w-3 h-3" /> Standup
          <span className="text-slate-500 font-normal">({filteredEntries.length})</span>
        </h3>

        <div className="flex items-center gap-2">
          {/* Schedule config */}
          <div className="flex items-center gap-1">
            <Clock className="w-3 h-3 text-slate-500" />
            <input
              type="time"
              value={schedule.time}
              onChange={handleTimeChange}
              className="bg-slate-800 text-slate-300 text-xs px-1 py-0.5 rounded border border-slate-700 w-20"
              title="Daily standup time"
            />
            <button
              onClick={handleScheduleToggle}
              className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                schedule.enabled
                  ? 'bg-green-700 text-green-200'
                  : 'bg-slate-800 text-slate-500 hover:text-slate-300'
              }`}
              title={schedule.enabled ? 'Disable daily standup' : 'Enable daily standup'}
            >
              {schedule.enabled ? 'On' : 'Off'}
            </button>
          </div>

          {/* Run Now */}
          <button
            onClick={handleRunNow}
            disabled={standupInProgress}
            className="flex items-center gap-1 text-xs px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Trigger standup now — notifies all agents"
          >
            <Play className="w-3 h-3" />
            {standupInProgress ? 'Sending...' : 'Run Now'}
          </button>

          {/* Mark reviewed */}
          <button
            onClick={markAsReviewed}
            className="p-1 text-slate-500 hover:text-slate-300 transition-colors"
            title="Mark all as reviewed"
          >
            <CheckCheck className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Agent filters */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-slate-800 shrink-0 overflow-x-auto">
        <Users className="w-3 h-3 text-slate-500 shrink-0" />
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
            className={`px-2 py-0.5 rounded text-xs transition-colors shrink-0 ${
              filters.agents.length === 0 || filters.agents.includes(name)
                ? 'bg-slate-700 text-slate-200'
                : 'bg-slate-800 text-slate-500'
            }`}
          >
            {name}
          </button>
        ))}
        {/* Time range filter */}
        <span className="text-slate-600 mx-1">|</span>
        {(['today', '24h', '7d'] as const).map((range) => (
          <button
            key={range}
            onClick={() => setFilters({ since: range })}
            className={`px-2 py-0.5 rounded text-xs transition-colors shrink-0 ${
              filters.since === range
                ? 'bg-slate-700 text-slate-200'
                : 'bg-slate-800 text-slate-500'
            }`}
          >
            {range === 'today' ? 'Today' : range === '24h' ? '24h' : '7d'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="text-xs text-slate-500 text-center py-4">Loading...</div>
        ) : error ? (
          <div className="text-xs text-red-400 text-center py-4">{error}</div>
        ) : filteredEntries.length === 0 ? (
          <div className="text-xs text-slate-500 text-center py-4">
            No standup entries.
            <button onClick={handleRunNow} className="text-amber-400 hover:text-amber-300 ml-1">
              Run a standup now?
            </button>
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {filteredEntries.slice(0, 50).map((entry) => (
              <div key={entry.id} className="flex items-start gap-2 px-3 py-2 hover:bg-slate-800/50">
                <span className={`text-sm mt-0.5 ${EVENT_COLORS[entry.event_type] || 'text-slate-400'}`}>
                  {EVENT_ICONS[entry.event_type] || '\u2022'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-300 font-medium">{entry.agent}</span>
                    <span className={`text-xs px-1 rounded ${EVENT_COLORS[entry.event_type] || 'text-slate-500'} bg-slate-800`}>
                      {entry.event_type.replace(/_/g, ' ')}
                    </span>
                    <span className="text-xs text-slate-500 ml-auto shrink-0">
                      {new Date(entry.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5 line-clamp-2">{entry.summary}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Meeting Notes History */}
        {meetingNotes.length > 0 && (
          <div className="border-t border-slate-700 px-3 py-2">
            <div className="flex items-center gap-1 mb-1">
              <History className="w-3 h-3 text-slate-500" />
              <span className="text-xs text-slate-500 font-medium">Past Standups</span>
            </div>
            {meetingNotes.slice(0, 5).map((note) => (
              <div key={note.id} className="bg-slate-800 rounded p-2 mb-1 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">{new Date(note.date).toLocaleDateString()}</span>
                  <span className="text-slate-500">{note.attendees.length} attended</span>
                </div>
                {note.summary && (
                  <div className="text-slate-400 mt-1 line-clamp-2">{note.summary}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
