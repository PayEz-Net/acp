import { useState, useEffect } from 'react';
import { X, Play, Square, Clock, AlertTriangle, Phone, ShieldOff, Activity } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useAutonomyStore } from '../../stores/autonomyStore';
import { StandupView } from './StandupView';
import { StopCondition } from '@shared/types';

export function AutonomyPanel() {
  const { autonomyPanelOpen, toggleAutonomyPanel, backendAvailable } = useAppStore();
  const { status, escalations, fetchStatus, startAutonomy, stopAutonomy } = useAutonomyStore();

  // Local form state
  const [specId, setSpecId] = useState<number | undefined>(status?.specId);
  const [milestone, setMilestone] = useState(status?.milestone || 'Day 1');
  const [stopCondition, setStopCondition] = useState<StopCondition>(status?.stopCondition || 'milestone');
  const [maxHours, setMaxHours] = useState(status?.maxRuntimeHours || 8);
  const [notifyPhone, setNotifyPhone] = useState(status?.notifyPhone || '');
  const [skipPermissions, setSkipPermissions] = useState(status?.skipPermissions || false);

  // Poll status every 10s when panel is open
  useEffect(() => {
    if (!autonomyPanelOpen || !backendAvailable) return;
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [autonomyPanelOpen, backendAvailable, fetchStatus]);

  if (!autonomyPanelOpen) return null;

  const isRunning = status?.enabled ?? false;

  const handleStart = async () => {
    if (backendAvailable) {
      await startAutonomy({
        specId,
        maxRuntimeHours: maxHours,
        stopCondition,
      });
    }
    toggleAutonomyPanel();
  };

  const handleStop = async () => {
    await stopAutonomy();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="autonomy-panel-title"
      className="fixed inset-0 z-50 flex items-start justify-center pt-20"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={toggleAutonomyPanel} />

      {/* Panel */}
      <div className="relative bg-slate-900 border border-slate-700 rounded-lg shadow-xl w-[480px] max-h-[80vh] overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-cyan-400" />
            <h2 id="autonomy-panel-title" className="text-lg font-semibold text-white">Autonomy</h2>
          </div>
          <button onClick={toggleAutonomyPanel} className="p-1 text-slate-400 hover:text-white transition-colors" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {!backendAvailable ? (
          <div className="p-4 text-sm text-slate-500 text-center">Backend required for autonomy</div>
        ) : (
          <>
            {/* Status Banner */}
            {isRunning && status && (
              <div className="mx-4 mt-4 p-3 bg-emerald-900/30 border border-emerald-700/50 rounded-lg">
                <div className="flex items-center gap-2 text-emerald-400">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="font-medium">Autonomous Mode Active</span>
                </div>
                <div className="mt-2 text-sm text-slate-400 space-y-0.5">
                  <div className="flex items-center gap-1"><Clock className="w-3 h-3" /> {status.elapsedMinutes || 0}m / {(status.maxRuntimeHours || 4) * 60}m</div>
                  {status.milestone && <div>Milestone: {status.milestone}</div>}
                  {status.stopCondition && <div>Stop on: {status.stopCondition}</div>}
                </div>
              </div>
            )}

            {/* Escalation Alerts */}
            {escalations.length > 0 && (
              <div className="mx-4 mt-3">
                <h3 className="text-xs font-semibold text-red-400 uppercase mb-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Escalations ({escalations.length})
                </h3>
                <div className="space-y-1">
                  {escalations.slice(0, 3).map((e) => (
                    <div key={e.id} className="bg-red-900/20 border border-red-800/30 rounded p-2 text-xs">
                      <span className="text-red-300 font-medium">{e.agent}</span>
                      <span className="text-slate-400"> — {e.summary}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Form */}
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Spec (optional)</label>
                <input
                  type="number"
                  value={specId || ''}
                  onChange={(e) => setSpecId(e.target.value ? Number(e.target.value) : undefined)}
                  placeholder="Enter spec document ID"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:border-vibe-500"
                  disabled={isRunning}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Milestone</label>
                <input type="text" value={milestone} onChange={(e) => setMilestone(e.target.value)} placeholder="e.g., Day 1, Phase 2"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:border-vibe-500" disabled={isRunning} />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Stop When</label>
                <div className="flex gap-2">
                  {(['milestone', 'blocker', 'time'] as StopCondition[]).map((cond) => (
                    <button key={cond} onClick={() => setStopCondition(cond)} disabled={isRunning}
                      className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
                        stopCondition === cond ? 'bg-vibe-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                      } ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      {cond.charAt(0).toUpperCase() + cond.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Max Runtime: {maxHours} hours</label>
                <input type="range" min="1" max="24" value={maxHours} onChange={(e) => setMaxHours(Number(e.target.value))}
                  className="w-full accent-vibe-500" disabled={isRunning} />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1"><Phone className="w-4 h-4 inline mr-1" />Notify Phone (SMS)</label>
                <input type="tel" value={notifyPhone} onChange={(e) => setNotifyPhone(e.target.value)} placeholder="+1 555 123 4567"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:border-vibe-500" disabled={isRunning} />
              </div>

              <div className="flex items-center justify-between p-3 bg-amber-900/20 border border-amber-700/50 rounded-lg">
                <div className="flex items-center gap-2">
                  <ShieldOff className="w-4 h-4 text-amber-400" />
                  <div>
                    <div className="text-sm font-medium text-slate-300">Skip Permission Prompts</div>
                    <div className="text-xs text-slate-500">--dangerously-skip-permissions</div>
                  </div>
                </div>
                <button type="button" role="switch" aria-checked={skipPermissions} onClick={() => setSkipPermissions(!skipPermissions)} disabled={isRunning}
                  className={`relative w-11 h-6 rounded-full transition-colors ${skipPermissions ? 'bg-amber-500' : 'bg-slate-600'} ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}>
                  <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${skipPermissions ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>
            </div>

            {/* Standup Log */}
            <div className="border-t border-slate-700">
              <StandupView />
            </div>

            {/* Actions */}
            <div className="p-4 border-t border-slate-700 flex gap-3">
              {isRunning ? (
                <button onClick={handleStop}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded font-medium transition-colors">
                  <Square className="w-4 h-4" /> Stop Autonomy
                </button>
              ) : (
                <button onClick={handleStart}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-medium transition-colors">
                  <Play className="w-4 h-4" /> Start Autonomy
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
