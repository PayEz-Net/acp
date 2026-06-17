import { User, Lock, Zap, Cpu } from 'lucide-react';
import type { SpecialistAgent } from '../../stores/specialistStore';
import { isCanonical, modelTierHint } from '../../stores/specialistStore';

interface AgentCatalogCardProps {
  agent: SpecialistAgent;
  isEngaged: boolean;
  onEngage: (agent: SpecialistAgent) => void;
}

function categoryIcon(category: string | null) {
  if (!category) return <User className="w-5 h-5" />;
  const c = category.toLowerCase();
  if (c.includes('arch') || c.includes('lead')) return <Cpu className="w-5 h-5" />;
  if (c.includes('qa') || c.includes('test')) return <Zap className="w-5 h-5" />;
  return <User className="w-5 h-5" />;
}

function tierBadge(tier: 'opus' | 'sonnet' | 'byos' | null) {
  if (!tier) return null;
  const styles = {
    opus: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    sonnet: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    byos: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  };
  const labels = { opus: 'Opus', sonnet: 'Sonnet', byos: 'BYOS' };
  return (
    <span className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border ${styles[tier]}`}>
      {labels[tier]}
    </span>
  );
}

export function AgentCatalogCard({ agent, isEngaged, onEngage }: AgentCatalogCardProps) {
  const tier = modelTierHint(agent.model);
  const grayed = !agent.isActive;
  const canonical = isCanonical(agent);

  return (
    <div
      className={`relative rounded-lg border p-3 transition-colors ${
        grayed
          ? 'bg-slate-900/40 border-slate-800 opacity-60'
          : 'bg-slate-900 border-slate-700 hover:border-slate-600'
      }`}
    >
      {/* Core badge for canonical 6 */}
      {canonical && (
        <span className="absolute top-2 right-2 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/30">
          core
        </span>
      )}

      {/* Locked badge for inactive */}
      {grayed && (
        <span className="absolute top-2 right-2 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-400 border border-slate-600/50 flex items-center gap-1">
          <Lock className="w-3 h-3" />
          locked
        </span>
      )}

      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${grayed ? 'bg-slate-800 text-slate-500' : 'bg-slate-800 text-slate-300'}`}>
          {categoryIcon(agent.agentType)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h4 className="text-sm font-semibold text-slate-200 truncate">{agent.displayName || agent.name}</h4>
            {tierBadge(tier)}
          </div>
          <p className="text-xs text-slate-400 line-clamp-2">
            {agent.description || agent.role || 'Specialist'}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">
          {agent.agentType || 'General'}
        </span>
        <button
          type="button"
          onClick={() => onEngage(agent)}
          disabled={isEngaged || grayed}
          className={`text-xs font-medium px-2.5 py-1 rounded transition-colors ${
            isEngaged
              ? 'bg-emerald-600/20 text-emerald-400 cursor-default'
              : grayed
                ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
          }`}
        >
          {isEngaged ? 'Engaged' : 'Engage'}
        </button>
      </div>
    </div>
  );
}
