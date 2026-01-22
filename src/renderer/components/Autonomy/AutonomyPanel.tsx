import { useState } from 'react';
import { X, Play, Square, Clock, AlertTriangle, Phone, ShieldOff } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { StopCondition } from '@shared/types';

export function AutonomyPanel() {
  const {
    autonomyEnabled,
    autonomyStatus,
    autonomyPanelOpen,
    toggleAutonomyPanel,
    setAutonomyEnabled,
    setAutonomyStatus,
  } = useAppStore();

  // Local form state
  const [specId, setSpecId] = useState<number | undefined>(autonomyStatus?.specId);
  const [milestone, setMilestone] = useState(autonomyStatus?.milestone || 'Day 1');
  const [stopCondition, setStopCondition] = useState<StopCondition>(autonomyStatus?.stopCondition || 'milestone');
  const [maxHours, setMaxHours] = useState(autonomyStatus?.maxRuntimeHours || 8);
  const [notifyPhone, setNotifyPhone] = useState(autonomyStatus?.notifyPhone || '');
  const [skipPermissions, setSkipPermissions] = useState(autonomyStatus?.skipPermissions || false);

  if (!autonomyPanelOpen) return null;

  const handleStart = async () => {
    // TODO: Call backend API POST /v1/autonomy/start
    // For now, stub with local state
    setAutonomyStatus({
      enabled: true,
      specId,
      specTitle: specId ? `Spec #${specId}` : undefined,
      milestone,
      stopCondition,
      maxRuntimeHours: maxHours,
      notifyPhone: notifyPhone || undefined,
      skipPermissions,
      startedAt: new Date().toISOString(),
      elapsedMinutes: 0,
    });
    toggleAutonomyPanel();
  };

  const handleStop = async () => {
    // TODO: Call backend API POST /v1/autonomy/stop
    setAutonomyStatus(null);
    setAutonomyEnabled(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="autonomy-panel-title"
      className="fixed inset-0 z-50 flex items-start justify-center pt-20"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={toggleAutonomyPanel}
      />

      {/* Panel */}
      <div className="relative bg-slate-900 border border-slate-700 rounded-lg shadow-xl w-96 max-h-[80vh] overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <h2 id="autonomy-panel-title" className="text-lg font-semibold text-white">Autonomy Settings</h2>
          <button
            onClick={toggleAutonomyPanel}
            className="p-1 text-slate-400 hover:text-white transition-colors"
            aria-label="Close autonomy settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Banner */}
        {autonomyEnabled && autonomyStatus && (
          <div className="mx-4 mt-4 p-3 bg-emerald-900/30 border border-emerald-700/50 rounded-lg">
            <div className="flex items-center gap-2 text-emerald-400">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="font-medium">Autonomous Mode Active</span>
            </div>
            <div className="mt-2 text-sm text-slate-400">
              <div>Milestone: {autonomyStatus.milestone}</div>
              <div>Elapsed: {autonomyStatus.elapsedMinutes || 0} min</div>
            </div>
          </div>
        )}

        {/* Form */}
        <div className="p-4 space-y-4">
          {/* Spec Selector */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              Spec (optional)
            </label>
            <input
              type="number"
              value={specId || ''}
              onChange={(e) => setSpecId(e.target.value ? Number(e.target.value) : undefined)}
              placeholder="Enter spec document ID"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:border-vibe-500"
              disabled={autonomyEnabled}
            />
          </div>

          {/* Milestone */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              Milestone
            </label>
            <input
              type="text"
              value={milestone}
              onChange={(e) => setMilestone(e.target.value)}
              placeholder="e.g., Day 1, Phase 2"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:border-vibe-500"
              disabled={autonomyEnabled}
            />
          </div>

          {/* Stop Condition */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              Stop When
            </label>
            <div className="flex gap-2">
              {(['milestone', 'blocker', 'time'] as StopCondition[]).map((condition) => (
                <button
                  key={condition}
                  onClick={() => setStopCondition(condition)}
                  disabled={autonomyEnabled}
                  className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
                    stopCondition === condition
                      ? 'bg-vibe-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  } ${autonomyEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {condition === 'milestone' && <AlertTriangle className="w-4 h-4 inline mr-1" />}
                  {condition === 'blocker' && <X className="w-4 h-4 inline mr-1" />}
                  {condition === 'time' && <Clock className="w-4 h-4 inline mr-1" />}
                  {condition.charAt(0).toUpperCase() + condition.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Max Runtime */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              Max Runtime: {maxHours} hours
            </label>
            <input
              type="range"
              min="1"
              max="24"
              value={maxHours}
              onChange={(e) => setMaxHours(Number(e.target.value))}
              className="w-full accent-vibe-500"
              disabled={autonomyEnabled}
            />
          </div>

          {/* Notify Phone */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              <Phone className="w-4 h-4 inline mr-1" />
              Notify Phone (SMS)
            </label>
            <input
              type="tel"
              value={notifyPhone}
              onChange={(e) => setNotifyPhone(e.target.value)}
              placeholder="+1 555 123 4567"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:border-vibe-500"
              disabled={autonomyEnabled}
            />
          </div>

          {/* Skip Permissions Toggle */}
          <div className="flex items-center justify-between p-3 bg-amber-900/20 border border-amber-700/50 rounded-lg">
            <div className="flex items-center gap-2">
              <ShieldOff className="w-4 h-4 text-amber-400" />
              <div>
                <div className="text-sm font-medium text-slate-300">Skip Permission Prompts</div>
                <div className="text-xs text-slate-500">Run agents with --dangerously-skip-permissions</div>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={skipPermissions}
              aria-label="Skip permission prompts"
              onClick={() => setSkipPermissions(!skipPermissions)}
              disabled={autonomyEnabled}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                skipPermissions ? 'bg-amber-500' : 'bg-slate-600'
              } ${autonomyEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <span
                className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${
                  skipPermissions ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-slate-700 flex gap-3">
          {autonomyEnabled ? (
            <button
              onClick={handleStop}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded font-medium transition-colors"
            >
              <Square className="w-4 h-4" />
              Stop Autonomy
            </button>
          ) : (
            <button
              onClick={handleStart}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-medium transition-colors"
            >
              <Play className="w-4 h-4" />
              Start Autonomy
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
