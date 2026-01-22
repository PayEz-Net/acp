import { useACPStore } from '../../stores/acpStore';
import { ACPEvent, ACP_CHARACTERS } from '@shared/types';

// Get color for agent name in event log
const getAgentColor = (agentName?: string): string => {
  if (!agentName) return '#94a3b8';
  const character = Object.values(ACP_CHARACTERS).find((c) => c.agentName === agentName);
  return character?.color || '#94a3b8';
};

// Get icon for event type
const getEventIcon = (type: ACPEvent['type']) => {
  switch (type) {
    case 'agent_completed':
      return (
        <svg className="w-4 h-4 text-emerald-500/50" fill="currentColor" viewBox="0 0 24 24">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      );
    case 'agent_blocked':
      return (
        <svg className="w-4 h-4 text-orange-500/50" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
        </svg>
      );
    case 'mingle_started':
    case 'mingle_ended':
      return (
        <svg className="w-4 h-4 text-cyan-500/50" fill="currentColor" viewBox="0 0 24 24">
          <path d="M16.5 13c-1.2 0-3.07.34-4.5 1-1.43-.67-3.3-1-4.5-1C5.33 13 1 14.08 1 16.25V19h22v-2.75c0-2.17-4.33-3.25-6.5-3.25zm-4 4.5h-10v-1.25c0-.54 2.56-1.75 5-1.75s5 1.21 5 1.75v1.25zm9 0H14v-1.25c0-.46-.2-.86-.52-1.22.88-.3 1.96-.53 3.02-.53 2.44 0 5 1.21 5 1.75v1.25zM7.5 12c1.93 0 3.5-1.57 3.5-3.5S9.43 5 7.5 5 4 6.57 4 8.5 5.57 12 7.5 12zm0-5.5c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm9 5.5c1.93 0 3.5-1.57 3.5-3.5S18.43 5 16.5 5 13 6.57 13 8.5s1.57 3.5 3.5 3.5zm0-5.5c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2z" />
        </svg>
      );
    case 'human_message':
      return (
        <svg className="w-4 h-4 text-violet-500/50" fill="currentColor" viewBox="0 0 24 24">
          <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z" />
        </svg>
      );
    default:
      return (
        <svg className="w-4 h-4 text-emerald-500/50" fill="currentColor" viewBox="0 0 24 24">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      );
  }
};

// Format event message with colored agent names
function EventMessage({ event }: { event: ACPEvent }) {
  const agentColor = getAgentColor(event.agentName);
  const targetColor = getAgentColor(event.targetAgentName);

  // Parse message to colorize agent names
  let message = event.message;
  const parts: React.ReactNode[] = [];

  if (event.agentName) {
    const agentIndex = message.indexOf(event.agentName);
    if (agentIndex !== -1) {
      parts.push(message.substring(0, agentIndex));
      parts.push(
        <span key="agent" style={{ color: agentColor }}>
          {event.agentName}
        </span>
      );
      message = message.substring(agentIndex + event.agentName.length);
    }
  }

  if (event.targetAgentName) {
    const targetIndex = message.indexOf(event.targetAgentName);
    if (targetIndex !== -1) {
      parts.push(message.substring(0, targetIndex));
      parts.push(
        <span key="target" style={{ color: targetColor }}>
          {event.targetAgentName}
        </span>
      );
      message = message.substring(targetIndex + event.targetAgentName.length);
    }
  }

  parts.push(message);

  return <>{parts}</>;
}

export function EventLog() {
  const { events, isPaused, togglePause, projectProgress } = useACPStore();

  return (
    <footer className="bg-[#0B1221] border-t border-slate-800 h-36 flex flex-col z-50 shadow-[0_-10px_30px_rgba(0,0,0,0.3)]">
      {/* Footer Controls Bar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-slate-800/50">
        <div className="flex gap-2">
          <button
            onClick={togglePause}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-[10px] font-black text-white transition-all border border-slate-700/50"
          >
            {isPaused ? (
              <>
                <svg className="w-3 h-3 text-cyan-400" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                RESUME
              </>
            ) : (
              <>
                <svg className="w-3 h-3 text-cyan-400" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
                PAUSE
              </>
            )}
          </button>
          <button className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-[10px] font-black text-white transition-all border border-slate-700/50">
            <svg className="w-3 h-3 text-cyan-400" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
            RESTART
          </button>
          <button className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-[10px] font-black text-white transition-all border border-slate-700/50 uppercase">
            All Agents
          </button>
        </div>

        <div className="h-4 w-[1px] bg-slate-800" />

        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">
          Simulation Mode:{' '}
          <span className={isPaused ? 'text-yellow-500' : 'text-emerald-500'}>
            {isPaused ? 'Paused' : 'Active'}
          </span>
        </div>

        {/* Progress indicator */}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-mono text-slate-500 uppercase">Progress:</span>
          <div className="w-24 h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-500 transition-all duration-500"
              style={{ width: `${projectProgress}%` }}
            />
          </div>
          <span className="text-[10px] font-bold text-cyan-400">{projectProgress}%</span>
        </div>
      </div>

      {/* Event Log Header */}
      <div className="flex items-center justify-between px-4 py-1">
        <span className="text-[10px] font-black text-slate-600 uppercase tracking-widest">
          System Event Log
        </span>
        <svg className="w-4 h-4 text-slate-600" fill="currentColor" viewBox="0 0 24 24">
          <path d="M20 19.59V8l-6-6H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c.45 0 .85-.15 1.19-.4l-4.43-4.43c-.8.52-1.74.83-2.76.83-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5c0 1.02-.31 1.96-.83 2.75L20 19.59zM9 13c0 1.66 1.34 3 3 3s3-1.34 3-3-1.34-3-3-3-3 1.34-3 3z" />
        </svg>
      </div>

      {/* Events List */}
      <div className="flex-1 overflow-y-auto px-4 space-y-1 font-mono text-[11px] text-slate-500">
        {events.slice(0, 10).map((event) => (
          <div key={event.id} className="flex items-center gap-2">
            {getEventIcon(event.type)}
            <span>
              [
              {event.timestamp.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
              ]{' '}
              <EventMessage event={event} />
            </span>
          </div>
        ))}
        {events.length === 0 && (
          <div className="text-slate-600 py-2">No events yet...</div>
        )}
      </div>
    </footer>
  );
}
