import { ACPAgent, ACPCharacter, ACP_CHARACTERS } from '@shared/types';

interface AgentSpriteProps {
  agent: ACPAgent;
  onClick?: () => void;
  size?: 'sm' | 'md' | 'lg';
}

// Character-specific accessories and styling
const CharacterVisuals: Record<ACPCharacter, React.FC<{ size: number }>> = {
  // Sage (BAPert) - Bowtie & Monocle
  sage: ({ size }) => (
    <div className="flex flex-col items-center relative">
      {/* Head + Monocle */}
      <div
        className="relative rounded-full bg-amber-500 mb-0.5 flex items-center justify-center"
        style={{
          width: size * 0.4,
          height: size * 0.4,
          boxShadow: '0 0 10px rgba(234,179,8,0.4)',
        }}
      >
        {/* Monocle */}
        <div
          className="absolute rounded-full border border-slate-900/40"
          style={{
            width: size * 0.2,
            height: size * 0.2,
            top: size * 0.05,
            right: 0,
          }}
        />
        {/* Eyes */}
        <div className="flex gap-0.5 mr-1">
          <div className="w-1 h-1 bg-slate-900/60 rounded-full" />
          <div className="w-1 h-1 bg-slate-900/60 rounded-full" />
        </div>
      </div>
      {/* Bowtie */}
      <div className="z-20 flex gap-0.5 -mb-0.5">
        <div className="w-2 h-2 bg-slate-900 rotate-45" />
        <div className="w-2 h-2 bg-slate-900 rotate-45" />
      </div>
      {/* Body */}
      <div
        className="rounded-full bg-amber-500"
        style={{
          width: size * 0.6,
          height: size,
          boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
        }}
      />
    </div>
  ),

  // Forge (DotNetPert) - Backwards Cap & Coffee
  forge: ({ size }) => (
    <div className="flex flex-col items-center relative">
      {/* Head + Cap */}
      <div
        className="relative rounded-full bg-cyan-500 mb-0.5 flex items-center justify-center pt-1"
        style={{
          width: size * 0.4,
          height: size * 0.4,
          boxShadow: '0 0 10px rgba(20,184,166,0.4)',
        }}
      >
        {/* Cap brim */}
        <div
          className="absolute bg-cyan-700 rounded-full"
          style={{
            width: size * 0.5,
            height: size * 0.15,
            top: -size * 0.05,
            left: -size * 0.1,
            transform: 'rotate(-10deg)',
          }}
        />
        {/* Cap back */}
        <div
          className="absolute bg-cyan-800 rounded-sm"
          style={{
            width: size * 0.25,
            height: size * 0.08,
            top: 0,
            right: -2,
          }}
        />
        {/* Eyes */}
        <div className="flex gap-0.5">
          <div className="w-1 h-1 bg-slate-900/70 rounded-full" />
          <div className="w-1 h-1 bg-slate-900/70 rounded-full" />
        </div>
      </div>
      {/* Body with rolled sleeves */}
      <div
        className="rounded-full bg-cyan-500 flex justify-between px-1 pt-2"
        style={{
          width: size * 0.8,
          height: size,
          boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
        }}
      >
        <div className="w-2 h-4 bg-cyan-300/40 rounded-sm" />
        <div className="w-2 h-4 bg-cyan-300/40 rounded-sm" />
      </div>
      {/* Coffee cup */}
      <div
        className="absolute bg-white rounded-sm shadow-sm border-r-2 border-slate-200"
        style={{
          width: size * 0.15,
          height: size * 0.2,
          bottom: size * 0.2,
          right: -size * 0.2,
        }}
      >
        <div
          className="absolute border border-slate-200 rounded-full"
          style={{
            width: size * 0.1,
            height: size * 0.1,
            right: -size * 0.08,
            top: size * 0.05,
          }}
        />
      </div>
    </div>
  ),

  // Pixel (NextPert) - Beret & Scarf
  pixel: ({ size }) => (
    <div className="flex flex-col items-center relative">
      {/* Head + Beret */}
      <div
        className="relative rounded-full bg-emerald-500 mb-0.5 flex items-center justify-center"
        style={{
          width: size * 0.4,
          height: size * 0.4,
          boxShadow: '0 0 10px rgba(52,211,153,0.6)',
        }}
      >
        {/* Beret */}
        <div
          className="absolute bg-emerald-700 rounded-full"
          style={{
            width: size * 0.5,
            height: size * 0.2,
            top: -size * 0.1,
            right: -size * 0.1,
            transform: 'rotate(15deg)',
          }}
        />
        {/* Eyes */}
        <div className="flex gap-0.5 mt-0.5">
          <div className="w-1 h-1 bg-white/90 rounded-full" />
          <div className="w-1 h-1 bg-white/90 rounded-full" />
        </div>
      </div>
      {/* Scarf */}
      <div
        className="z-20 bg-emerald-200 rounded-full -mb-1"
        style={{ width: size * 0.5, height: size * 0.12 }}
      />
      <div
        className="z-20 absolute bg-emerald-200 rounded-sm"
        style={{
          width: size * 0.08,
          height: size * 0.25,
          top: size * 0.5,
          right: size * 0.1,
          transform: 'rotate(10deg)',
        }}
      />
      {/* Body */}
      <div
        className="rounded-full bg-emerald-500"
        style={{
          width: size * 0.5,
          height: size,
          boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
        }}
      />
    </div>
  ),

  // Nova (NextPertTwo) - Hoodie & Sneakers
  nova: ({ size }) => (
    <div className="flex flex-col items-center relative">
      {/* Hoodie Hood */}
      <div
        className="absolute bg-green-600 rounded-full -z-10"
        style={{
          width: size * 0.6,
          height: size * 0.6,
          top: -size * 0.08,
        }}
      />
      {/* Head */}
      <div
        className="rounded-full bg-green-500 mb-0.5 flex items-center justify-center"
        style={{
          width: size * 0.4,
          height: size * 0.4,
          boxShadow: '0 0 10px rgba(74,222,128,0.4)',
        }}
      >
        {/* Eyes */}
        <div className="flex gap-0.5">
          <div className="w-1 h-1 bg-white/80 rounded-full" />
          <div className="w-1 h-1 bg-white/80 rounded-full" />
        </div>
      </div>
      {/* Hoodie Body */}
      <div
        className="rounded-2xl bg-green-500 relative flex flex-col items-center"
        style={{
          width: size * 0.7,
          height: size * 1.1,
          boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
        }}
      >
        {/* Drawstrings */}
        <div className="absolute top-1 flex gap-2">
          <div className="w-0.5 h-4 bg-white/30 rounded-full" />
          <div className="w-0.5 h-4 bg-white/30 rounded-full" />
        </div>
        {/* Pocket */}
        <div
          className="mt-auto mb-2 border border-green-600/50 rounded-md"
          style={{ width: size * 0.35, height: size * 0.25 }}
        />
      </div>
      {/* Sneakers */}
      <div className="flex gap-1 -mt-1">
        <div className="w-3 h-2 bg-white rounded-full shadow-sm" />
        <div className="w-3 h-2 bg-white rounded-full shadow-sm" />
      </div>
    </div>
  ),

  // Raven (QAPert) - Turtleneck & Glasses
  raven: ({ size }) => (
    <div className="flex flex-col items-center relative">
      {/* Head + Glasses */}
      <div
        className="relative rounded-full bg-purple-500 mb-0.5 flex items-center justify-center"
        style={{
          width: size * 0.4,
          height: size * 0.4,
          boxShadow: '0 0 10px rgba(168,85,247,0.4)',
        }}
      >
        {/* Eyes behind glasses */}
        <div className="flex gap-0.5 z-0">
          <div className="w-1 h-1 bg-slate-900/80 rounded-full" />
          <div className="w-1 h-1 bg-slate-900/80 rounded-full" />
        </div>
        {/* Glasses frame */}
        <div
          className="absolute bg-slate-900/60 z-10"
          style={{
            width: size * 0.4,
            height: 2,
            top: size * 0.15,
            left: 0,
          }}
        />
      </div>
      {/* Turtleneck Collar */}
      <div
        className="z-10 bg-purple-800 rounded-sm -mb-0.5"
        style={{ width: size * 0.35, height: size * 0.12 }}
      />
      {/* Body */}
      <div
        className="rounded-t-lg rounded-b-full bg-purple-500"
        style={{
          width: size * 0.5,
          height: size * 1.2,
          boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
        }}
      />
    </div>
  ),
};

// Status indicator styles
const getStatusIndicator = (status: ACPAgent['status']) => {
  switch (status) {
    case 'working':
      return 'animate-pulse';
    case 'blocked':
      return 'ring-2 ring-orange-500 ring-offset-2 ring-offset-slate-900 animate-pulse';
    case 'mingling':
      return 'ring-2 ring-cyan-400 ring-offset-2 ring-offset-slate-900';
    case 'paused':
      return 'ring-2 ring-yellow-400 ring-offset-2 ring-offset-slate-900 opacity-70';
    case 'celebrating':
      return 'animate-bounce';
    default:
      return '';
  }
};

export function AgentSprite({ agent, onClick, size = 'md' }: AgentSpriteProps) {
  const config = ACP_CHARACTERS[agent.character];
  const CharacterVisual = CharacterVisuals[agent.character];

  const sizeMap = { sm: 40, md: 60, lg: 80 };
  const pixelSize = sizeMap[size];

  const statusClass = getStatusIndicator(agent.status);

  return (
    <div
      className={`absolute cursor-pointer group z-40 transition-all duration-300 ${
        agent.selected ? 'scale-110 z-50' : 'hover:scale-105'
      }`}
      style={{
        left: `${agent.position.x}%`,
        top: `${agent.position.y}%`,
        transform: 'translate(-50%, -50%)',
      }}
      onClick={onClick}
    >
      <div className="flex flex-col items-center">
        {/* Selected indicator */}
        {agent.selected && (
          <div
            className="absolute rounded-full border border-cyan-400/50 animate-pulse"
            style={{
              inset: -8,
              borderWidth: 2,
            }}
          />
        )}

        {/* Character visual */}
        <div className={`relative ${statusClass}`}>
          <CharacterVisual size={pixelSize} />
        </div>

        {/* Name label */}
        <span
          className="mt-2 px-2 py-0.5 bg-slate-900/80 rounded text-[10px] font-bold whitespace-nowrap"
          style={{ color: config.color }}
        >
          {config.displayName}
        </span>

        {/* Status indicator for blocked/paused */}
        {(agent.status === 'blocked' || agent.status === 'paused') && (
          <div className="absolute -top-2 -right-2 w-4 h-4 bg-orange-500 rounded-full flex items-center justify-center text-white text-[8px] font-bold animate-pulse">
            {agent.status === 'blocked' ? '!' : '||'}
          </div>
        )}

        {/* Task progress (shown on hover) */}
        {agent.currentTask && agent.taskProgress !== undefined && (
          <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="bg-slate-800/90 rounded px-2 py-1 text-[9px] text-slate-300 whitespace-nowrap">
              {agent.taskProgress}%
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
