import { useState } from 'react';
import { Zap, ZapOff } from 'lucide-react';
import { useAutonomyStore } from '../../stores/autonomyStore';
import { useAppStore } from '../../stores/appStore';
import { UnattendedConfigModal } from './UnattendedConfigModal';

export function UnattendedToggle() {
  const { unattended, stopUnattended } = useAutonomyStore();
  const { backendAvailable } = useAppStore();
  const [showConfig, setShowConfig] = useState(false);

  const handleToggle = () => {
    if (unattended.active) {
      stopUnattended('manual');
    } else {
      setShowConfig(true);
    }
  };

  if (!backendAvailable) {
    return (
      <button
        disabled
        className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs text-slate-600 cursor-not-allowed"
        title="Backend required for unattended mode"
      >
        <ZapOff className="w-3.5 h-3.5" />
        <span>Unattended</span>
      </button>
    );
  }

  return (
    <>
      <button
        onClick={handleToggle}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-all ${
          unattended.active
            ? 'bg-emerald-600/20 border border-emerald-500/50 text-emerald-400 hover:bg-emerald-600/30'
            : 'border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600'
        }`}
        title={unattended.active ? 'Click to stop unattended mode' : 'Click to enable unattended mode'}
      >
        <Zap className={`w-3.5 h-3.5 ${unattended.active ? 'animate-pulse' : ''}`} />
        <span>Unattended</span>
        <span className={`w-1.5 h-1.5 rounded-full ${unattended.active ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
      </button>

      {showConfig && (
        <UnattendedConfigModal onClose={() => setShowConfig(false)} />
      )}
    </>
  );
}
