import { useACPStore } from '../../stores/acpStore';

interface ACPHeaderProps {
  onToggleMail?: () => void;
  onToggleKanban?: () => void;
  showMail?: boolean;
  showKanban?: boolean;
}

export function ACPHeader({ onToggleMail, onToggleKanban, showMail, showKanban }: ACPHeaderProps) {
  const { agents, isPaused, togglePause } = useACPStore();

  const blockedCount = agents.filter((a) => a.status === 'blocked').length;

  return (
    <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800/50 bg-[#0B1221]/80 backdrop-blur-sm z-50">
      <div className="flex items-center gap-6">
        {/* Title */}
        <h1 className="text-lg font-bold text-white tracking-tight">
          Agent Collaboration Platform
        </h1>

        {/* Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={togglePause}
            className="p-2 hover:bg-slate-800 rounded-lg transition-colors group"
            title={isPaused ? 'Resume Simulation' : 'Pause Simulation'}
          >
            {isPaused ? (
              <svg className="w-5 h-5 text-slate-400 group-hover:text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-slate-400 group-hover:text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            )}
          </button>
          <button
            className="p-2 hover:bg-slate-800 rounded-lg transition-colors group"
            title="Restart Simulation"
          >
            <svg className="w-5 h-5 text-slate-400 group-hover:text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
          </button>

          {/* Agent count badge */}
          <div className="px-3 py-1.5 bg-slate-800/50 rounded border border-slate-700/50">
            <span className="text-xs font-bold text-white">{agents.length} agents</span>
            {blockedCount > 0 && (
              <span className="ml-2 px-1.5 py-0.5 bg-orange-500/20 text-orange-400 rounded text-[10px] font-bold">
                {blockedCount} blocked
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Right side - Project selector & toggles */}
      <div className="flex items-center gap-3">
        {/* Mail toggle */}
        {onToggleMail && (
          <button
            onClick={onToggleMail}
            className={`p-2 rounded-lg transition-colors ${
              showMail
                ? 'bg-violet-600 text-white'
                : 'text-slate-400 hover:bg-slate-800 hover:text-white'
            }`}
            title={showMail ? 'Hide Mail' : 'Show Mail'}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </button>
        )}

        {/* Kanban toggle */}
        {onToggleKanban && (
          <button
            onClick={onToggleKanban}
            className={`p-2 rounded-lg transition-colors ${
              showKanban
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:bg-slate-800 hover:text-white'
            }`}
            title={showKanban ? 'Hide Kanban' : 'Show Kanban'}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </button>
        )}

        <div className="h-6 w-[1px] bg-slate-700" />

        {/* Project selector buttons */}
        <button className="px-3 py-1.5 rounded bg-slate-800/50 border border-slate-700 text-xs hover:border-cyan-500/50 transition-all uppercase text-slate-400 hover:text-white">
          CRYPTAPLY
        </button>
        <button className="px-3 py-1.5 rounded bg-slate-800/50 border border-slate-700 text-xs hover:border-cyan-500/50 transition-all uppercase text-slate-400 hover:text-white">
          IDEALRESUME
        </button>
        <button className="px-3 py-1.5 rounded bg-cyan-500 text-slate-950 font-bold text-xs shadow-lg shadow-cyan-500/20 uppercase">
          PAYEZ
        </button>
      </div>
    </header>
  );
}
