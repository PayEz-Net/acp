import { useState, useEffect } from 'react';
import { Zap, X } from 'lucide-react';
import { useAutonomyStore, UnattendedConfig } from '../../stores/autonomyStore';
import { useAppStore } from '../../stores/appStore';

interface UnattendedConfigModalProps {
  onClose: () => void;
}

export function UnattendedConfigModal({ onClose }: UnattendedConfigModalProps) {
  const { startUnattended } = useAutonomyStore();
  const agents = useAppStore((s) => s.agents);
  const [leadAgent, setLeadAgent] = useState('BAPert');
  const [pingIntervalMinutes, setPingIntervalMinutes] = useState(10);
  const [maxRuntimeHours, setMaxRuntimeHours] = useState(8);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleStart = async () => {
    setStarting(true);
    setError('');
    const config: UnattendedConfig = {
      leadAgent,
      pingIntervalMinutes,
      maxRuntimeHours,
    };
    const success = await startUnattended(config);
    setStarting(false);
    if (success) {
      onClose();
    } else {
      setError('Failed to start unattended mode. Check that the backend is running.');
    }
  };

  const agentNames = agents?.length
    ? agents.map((a) => (typeof a === 'string' ? a : a.name))
    : ['BAPert', 'DotNetPert', 'NextPert', 'QAPert'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[380px] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-emerald-400" />
              <span className="text-sm font-semibold text-slate-200">Go Unattended</span>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-1.5">
            Pings your lead agent on a timer to check progress and keep working.
          </p>
        </div>

        {/* Form */}
        <div className="px-5 py-4 space-y-4">
          {/* Lead Agent */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Lead Agent</label>
            <select
              value={leadAgent}
              onChange={(e) => setLeadAgent(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-slate-800 border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {agentNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>

          {/* Ping Interval */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Check-in every: <span className="text-emerald-400">{pingIntervalMinutes} min</span>
            </label>
            <input
              type="range"
              min={5}
              max={30}
              step={5}
              value={pingIntervalMinutes}
              onChange={(e) => setPingIntervalMinutes(Number(e.target.value))}
              className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
            />
            <div className="flex justify-between text-[10px] text-slate-600 mt-1">
              <span>5m</span>
              <span>15m</span>
              <span>30m</span>
            </div>
          </div>

          {/* Max Runtime */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Max runtime: <span className="text-emerald-400">{maxRuntimeHours}h</span>
            </label>
            <input
              type="range"
              min={1}
              max={24}
              value={maxRuntimeHours}
              onChange={(e) => setMaxRuntimeHours(Number(e.target.value))}
              className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
            />
            <div className="flex justify-between text-[10px] text-slate-600 mt-1">
              <span>1h</span>
              <span>12h</span>
              <span>24h</span>
            </div>
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/50 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-700 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={starting}
            className="flex items-center gap-2 px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            <Zap className="w-3.5 h-3.5" />
            {starting ? 'Starting...' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
