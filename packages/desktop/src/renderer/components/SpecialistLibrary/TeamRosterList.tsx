import { ArrowUp, ArrowDown, X, Lock } from 'lucide-react';
import type { RosterEntry } from '../../stores/specialistStore';
import { isCanonical } from '../../stores/specialistStore';

interface TeamRosterListProps {
  roster: RosterEntry[];
  onReorder: (oldIndex: number, newIndex: number) => void;
  onRemove: (agentId: number) => void;
}

export function TeamRosterList({ roster, onReorder, onRemove }: TeamRosterListProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-slate-700">
        <h3 className="text-sm font-semibold text-slate-200">Specialist Bench</h3>
        <p className="text-[11px] text-slate-500 mt-0.5">
          {roster.length === 0
            ? 'No specialists engaged yet. Browse the catalog and Engage the ones you need.'
            : `${roster.length} specialist${roster.length === 1 ? '' : 's'} engaged`}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {roster.map((agent, index) => {
          const canonical = isCanonical(agent);
          const grayed = !agent.isActive;

          return (
            <div
              key={agent.id}
              className={`flex items-center gap-2 p-2 rounded border ${
                grayed
                  ? 'bg-slate-900/40 border-slate-800 opacity-60'
                  : 'bg-slate-900 border-slate-700'
              }`}
            >
              {/* Reorder controls */}
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => onReorder(index, index - 1)}
                  disabled={index === 0}
                  className="p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Move up"
                >
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onReorder(index, index + 1)}
                  disabled={index === roster.length - 1}
                  className="p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Move down"
                >
                  <ArrowDown className="w-3 h-3" />
                </button>
              </div>

              {/* Agent info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-slate-200 truncate">
                    {agent.displayName || agent.name}
                  </span>
                  {canonical && (
                    <span className="text-[9px] uppercase tracking-wider font-bold px-1 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/30">
                      core
                    </span>
                  )}
                  {grayed && (
                    <span className="text-[9px] uppercase tracking-wider font-bold px-1 py-0.5 rounded bg-slate-700/50 text-slate-400 border border-slate-600/50 flex items-center gap-0.5">
                      <Lock className="w-2.5 h-2.5" />
                      locked
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-slate-500 truncate">
                  {agent.role || 'Specialist'}
                </p>
              </div>

              {/* Remove button — disabled for canonical */}
              <button
                type="button"
                onClick={() => onRemove(agent.id)}
                disabled={canonical}
                title={canonical ? 'Core specialists cannot be removed' : 'Remove from bench'}
                className="p-1 text-slate-500 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
