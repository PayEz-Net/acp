import { useState, useEffect } from 'react';
import { Zap, X } from 'lucide-react';
import { useAutonomyStore, UnattendedConfig } from '../../stores/autonomyStore';

const STOP_CONDITIONS = [
  { value: 'milestone', label: 'Milestone complete' },
  { value: 'time', label: 'Time limit' },
  { value: 'blocker', label: 'Blocker threshold' },
  { value: 'manual', label: 'Manual only' },
] as const;

const ESCALATION_LEVELS = [
  { value: 1, label: 'Relaxed', desc: 'Only critical failures' },
  { value: 2, label: 'Balanced', desc: 'Failures + repeated blocks' },
  { value: 3, label: 'Cautious', desc: 'Any block or test failure' },
  { value: 4, label: 'Strict', desc: 'Stop on first issue' },
] as const;

interface UnattendedConfigModalProps {
  onClose: () => void;
}

export function UnattendedConfigModal({ onClose }: UnattendedConfigModalProps) {
  const { startUnattended } = useAutonomyStore();
  const [stopCondition, setStopCondition] = useState<UnattendedConfig['stopCondition']>('milestone');
  const [escalationLevel, setEscalationLevel] = useState<UnattendedConfig['escalationLevel']>(2);
  const [maxRuntimeHours, setMaxRuntimeHours] = useState(4);
  const [notifyPhone, setNotifyPhone] = useState('');
  const [notifyWebhook, setNotifyWebhook] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  // Escape key closes modal
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
      stopCondition,
      maxRuntimeHours,
      escalationLevel,
      ...(notifyPhone.trim() ? { notifyPhone: notifyPhone.trim() } : {}),
      ...(notifyWebhook.trim() ? { notifyWebhook: notifyWebhook.trim() } : {}),
    };
    const success = await startUnattended(config);
    setStarting(false);
    if (success) {
      onClose();
    } else {
      setError('Failed to start unattended mode. Backend may not support this endpoint yet.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[440px] max-h-[80vh] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-emerald-400" />
              <span className="text-sm font-semibold text-slate-200">Enable Unattended Mode</span>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-1.5">
            Agents will work autonomously using the cocktail algorithm for coordination.
          </p>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Stop Condition */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-2">Stop Condition</label>
            <div className="grid grid-cols-2 gap-2">
              {STOP_CONDITIONS.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setStopCondition(value)}
                  className={`px-3 py-2 rounded text-xs font-medium transition-colors border ${
                    stopCondition === value
                      ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-400'
                      : 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Escalation Level */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-2">Escalation Level</label>
            <div className="space-y-1.5">
              {ESCALATION_LEVELS.map(({ value, label, desc }) => (
                <button
                  key={value}
                  onClick={() => setEscalationLevel(value)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded text-xs transition-colors border ${
                    escalationLevel === value
                      ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-400'
                      : 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                  }`}
                >
                  <span className="font-medium">{label}</span>
                  <span className="text-slate-500">{desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Max Runtime */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-2">
              Max Runtime: <span className="text-emerald-400">{maxRuntimeHours}h</span>
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

          {/* Notify */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-2">Notifications (optional)</label>
            <div className="space-y-2">
              <input
                type="text"
                placeholder="Phone number for SMS"
                value={notifyPhone}
                onChange={(e) => setNotifyPhone(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-800 border border-slate-700 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
              />
              <input
                type="text"
                placeholder="Webhook URL"
                value={notifyWebhook}
                onChange={(e) => setNotifyWebhook(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-800 border border-slate-700 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
              />
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
            {starting ? 'Starting...' : 'Start Unattended'}
          </button>
        </div>
      </div>
    </div>
  );
}
