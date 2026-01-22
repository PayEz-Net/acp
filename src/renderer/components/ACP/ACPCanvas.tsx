import { useACPStore } from '../../stores/acpStore';
import { AgentSprite } from './AgentSprite';

// Table component for work zones
function WorkTable({
  label,
  icon,
  color,
  isComplete,
}: {
  label: string;
  icon: string;
  color: string;
  isComplete?: boolean;
}) {
  return (
    <div className="wood-table rounded-xl p-4 flex flex-col items-center justify-center relative min-h-[90px] overflow-hidden group">
      {/* Lamp decoration */}
      <div className="absolute top-1 right-2 opacity-20">
        <svg className="w-4 h-4 text-amber-200" fill="currentColor" viewBox="0 0 24 24">
          <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z" />
        </svg>
      </div>

      {/* Monitor */}
      <div className="w-12 h-7 bg-slate-900 border-2 border-slate-700 rounded mb-2 shadow-inner flex items-center justify-center">
        <div
          className="w-10 h-5 flex items-center justify-center"
          style={{ backgroundColor: `${color}10` }}
        >
          <span className="text-[10px]" style={{ color: `${color}60` }}>
            {icon}
          </span>
        </div>
      </div>

      {/* Label with status */}
      <div className="flex items-center gap-2">
        {isComplete ? (
          <svg className="w-4 h-4 text-emerald-500" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
          </svg>
        ) : (
          <div className="w-4 h-4 rounded-full border-2 border-slate-600" />
        )}
        <span className="text-xs font-bold text-slate-200 uppercase tracking-tight">{label}</span>
      </div>

      {/* Desk label */}
      <span className="absolute top-1 left-2 text-[8px] text-amber-900/60 uppercase font-black">
        Desk
      </span>
    </div>
  );
}

// Bar zone component
function BarZone() {
  return (
    <div className="absolute left-4 top-1/2 -translate-y-1/2 w-28 h-64 bg-[#1a130e]/80 border border-[#4a3428] rounded-2xl flex flex-col overflow-hidden furniture-glow">
      {/* Bar top */}
      <div className="w-full h-8 bg-[#2D1F16] border-b border-[#4a3428] flex items-center px-3 gap-1">
        <div className="w-1.5 h-1.5 rounded-full bg-amber-700" />
        <div className="w-1.5 h-1.5 rounded-full bg-amber-700" />
        <div className="w-1.5 h-1.5 rounded-full bg-amber-700" />
      </div>

      {/* Bar content */}
      <div className="flex-1 relative flex flex-col items-center justify-center py-6 gap-6">
        <svg className="w-8 h-8 text-amber-500/20" fill="currentColor" viewBox="0 0 24 24">
          <path d="M18.32 8H5.67L5.23 4H4v2h.67l2 16h10.67l2-16H20V4h-1.23l-.45 4zm-2.24 2l-1 8H8.92l-1-8h8.16z" />
        </svg>

        <div className="flex flex-col gap-3">
          <div className="w-8 h-1 bg-amber-900/40 rounded-full" />
          <div className="w-12 h-1 bg-amber-900/40 rounded-full" />
          <div className="w-10 h-1 bg-amber-900/40 rounded-full" />
        </div>

        <svg className="w-6 h-6 text-red-500/10" fill="currentColor" viewBox="0 0 24 24">
          <path d="M6 3l1.5 2.5L6 8h12l-1.5-2.5L18 3H6zm.5 6L5 12v2h1v6h2v-6h8v6h2v-6h1v-2l-1.5-3h-11z" />
        </svg>

        {/* Bar counter */}
        <div className="absolute top-0 right-0 w-10 h-full bg-[#2a1d15] border-l border-[#4a3428]/50 shadow-[-4px_0_10px_rgba(0,0,0,0.3)]" />
      </div>

      {/* Label */}
      <span className="absolute bottom-8 left-4 -rotate-90 origin-bottom-left text-[10px] font-black tracking-widest text-amber-900/40 uppercase">
        Bar Zone
      </span>
    </div>
  );
}

// Lounge area component
function LoungeArea() {
  return (
    <div className="absolute right-4 bottom-20 w-72 h-56 bg-slate-900/30 border border-slate-700/30 rounded-[3rem] flex items-center justify-center furniture-glow overflow-hidden">
      {/* Rug */}
      <div className="absolute inset-6 border border-slate-700/20 rounded-[2.5rem] bg-indigo-950/10 flex items-center justify-center">
        <div className="w-full h-full border border-slate-800/10 rounded-[2rem] m-2 border-dashed" />
      </div>

      {/* Side sofa */}
      <div className="absolute left-8 top-1/2 -translate-y-1/2 w-8 h-28 bg-slate-800 rounded-2xl shadow-lg border border-slate-700/50" />

      {/* Main sofa */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-36 h-8 bg-slate-800 rounded-2xl shadow-lg border border-slate-700/50" />

      {/* Coffee table */}
      <div className="w-14 h-14 bg-slate-900 rounded-full border border-slate-700 shadow-2xl z-10 flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border border-slate-800 bg-slate-900 shadow-inner flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-slate-800" />
        </div>
      </div>

      {/* Label */}
      <span className="absolute top-4 left-1/2 -translate-x-1/2 text-[10px] font-black tracking-widest text-slate-700 uppercase">
        Lounge
      </span>
    </div>
  );
}

// Entrance component
function Entrance() {
  return (
    <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-44 h-14 bg-slate-800/20 border-t-2 border-x-2 border-slate-700/50 rounded-t-3xl flex flex-col items-center justify-end pb-2">
      {/* Welcome mat */}
      <div className="w-28 h-5 bg-slate-900 rounded-lg shadow-inner mb-1 flex items-center justify-center border border-slate-800">
        <span className="text-[8px] font-black text-slate-600 tracking-[0.2em] uppercase">
          Welcome
        </span>
      </div>
      <div className="flex gap-4">
        <div className="w-1 h-1 rounded-full bg-slate-600" />
        <div className="w-1 h-1 rounded-full bg-slate-600" />
      </div>
    </div>
  );
}

export function ACPCanvas() {
  const { agents, selectAgent, selectedAgentId } = useACPStore();

  const handleAgentClick = (agentId: string) => {
    selectAgent(selectedAgentId === agentId ? null : agentId);
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    // Only deselect if clicking on the canvas background
    if (e.target === e.currentTarget) {
      selectAgent(null);
    }
  };

  return (
    <div
      className="flex-1 relative grid-bg overflow-hidden"
      onClick={handleCanvasClick}
    >
      {/* Work Tables */}
      <div className="absolute top-4 left-36 right-4 grid grid-cols-4 gap-4">
        <WorkTable label="DB Architecture" icon="DB" color="#06b6d4" isComplete />
        <WorkTable label="UI Components" icon="UI" color="#ec4899" />
        <WorkTable label="API Routes" icon="API" color="#10b981" />
        <WorkTable label="QA Testing" icon="QA" color="#f59e0b" />
      </div>

      {/* Bar Zone */}
      <BarZone />

      {/* Lounge Area */}
      <LoungeArea />

      {/* Entrance */}
      <Entrance />

      {/* Agent Sprites */}
      {agents.map((agent) => (
        <AgentSprite
          key={agent.id}
          agent={agent}
          onClick={() => handleAgentClick(agent.id)}
        />
      ))}

      {/* Mingle connection lines */}
      <svg className="absolute inset-0 pointer-events-none" style={{ zIndex: 30 }}>
        {agents
          .filter((a) => a.minglingWith)
          .map((agent) => {
            const target = agents.find((a) => a.id === agent.minglingWith);
            if (!target || agent.id > target.id) return null; // Avoid duplicate lines

            return (
              <line
                key={`${agent.id}-${target.id}`}
                x1={`${agent.position.x}%`}
                y1={`${agent.position.y}%`}
                x2={`${target.position.x}%`}
                y2={`${target.position.y}%`}
                stroke="rgba(6, 182, 212, 0.5)"
                strokeWidth="2"
                strokeDasharray="4 4"
                className="animate-pulse"
              />
            );
          })}
      </svg>
    </div>
  );
}
