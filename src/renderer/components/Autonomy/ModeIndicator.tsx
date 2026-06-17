import { Radio } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';

export function ModeIndicator() {
  const { autonomyEnabled, toggleAutonomyPanel } = useAppStore();

  return (
    <button
      onClick={toggleAutonomyPanel}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all ${
        autonomyEnabled
          ? 'bg-emerald-600/20 border border-emerald-500/50 text-emerald-400'
          : 'bg-slate-800 border border-slate-700 text-slate-400 hover:bg-slate-700'
      }`}
      title={autonomyEnabled ? 'AUTONOMOUS - Click to configure' : 'ATTENDED - Click to configure'}
      aria-label={autonomyEnabled ? 'Autonomous mode active - click to configure' : 'Attended mode - click to configure autonomy'}
    >
      <Radio
        className={`w-4 h-4 ${autonomyEnabled ? 'animate-pulse' : ''}`}
      />
      <span className="text-xs font-medium uppercase tracking-wide">
        {autonomyEnabled ? 'Autonomous' : 'Attended'}
      </span>
      {autonomyEnabled && (
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
      )}
    </button>
  );
}
