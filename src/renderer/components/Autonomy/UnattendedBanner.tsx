import { useEffect, useState } from 'react';
import { Zap, Pause, Play, ClipboardList, X } from 'lucide-react';
import { useAutonomyStore } from '../../stores/autonomyStore';
import { useAppStore } from '../../stores/appStore';

function formatRuntime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const ESCALATION_LABELS: Record<number, string> = {
  1: 'relaxed',
  2: 'balanced',
  3: 'cautious',
  4: 'strict',
};

export function UnattendedBanner() {
  const { unattended, startUnattended, dismissPaused } = useAutonomyStore();
  const { backendAvailable } = useAppStore();
  const [elapsed, setElapsed] = useState(0);
  const [resuming, setResuming] = useState(false);

  // Live elapsed time counter
  useEffect(() => {
    if (!unattended.active || !unattended.startedAt) return;
    const start = new Date(unattended.startedAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 60000));
    tick();
    const interval = setInterval(tick, 10000);
    return () => clearInterval(interval);
  }, [unattended.active, unattended.startedAt]);

  // Use server-side elapsed if available
  const displayElapsed = unattended.elapsedMinutes ?? elapsed;

  // Active banner
  if (unattended.active) {
    const escalation = unattended.config?.escalationLevel
      ? ESCALATION_LABELS[unattended.config.escalationLevel] || 'balanced'
      : 'balanced';

    return (
      <div className="h-7 bg-emerald-950/80 border-b border-emerald-800/50 flex items-center justify-between px-4 text-xs">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3 h-3 text-emerald-400 animate-pulse" />
            <span className="font-semibold text-emerald-400">UNATTENDED</span>
          </div>
          <div className="w-px h-3.5 bg-emerald-800/50" />
          <span className="text-emerald-300/70">Running {formatRuntime(displayElapsed)}</span>
          <div className="w-px h-3.5 bg-emerald-800/50" />
          <span className="text-emerald-300/70">{unattended.tasksCompleted ?? 0} tasks done</span>
          <div className="w-px h-3.5 bg-emerald-800/50" />
          <span className="text-emerald-300/70">{unattended.tasksBlocked ?? 0} blocked</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-emerald-300/50">
            Stop: {unattended.config?.stopCondition || 'milestone'}
          </span>
          <div className="w-px h-3.5 bg-emerald-800/50" />
          <span className="text-emerald-300/50">Escalation: {escalation}</span>
        </div>
      </div>
    );
  }

  // Paused banner
  if (unattended.paused) {
    const handleResume = async () => {
      if (!unattended.config || !backendAvailable) return;
      setResuming(true);
      await startUnattended(unattended.config);
      setResuming(false);
    };

    return (
      <div className="h-8 bg-amber-950/80 border-b border-amber-800/50 flex items-center justify-between px-4 text-xs">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Pause className="w-3 h-3 text-amber-400" />
            <span className="font-semibold text-amber-400">PAUSED</span>
          </div>
          <div className="w-px h-3.5 bg-amber-800/50" />
          <span className="text-amber-300/70">Ran {formatRuntime(displayElapsed)}</span>
          <div className="w-px h-3.5 bg-amber-800/50" />
          <span className="text-amber-300/70">{unattended.tasksCompleted ?? 0} tasks done</span>
          <div className="w-px h-3.5 bg-amber-800/50" />
          <span className="text-amber-300/70">
            Reason: {unattended.pauseReason || 'unknown'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {unattended.config && (
            <button
              onClick={handleResume}
              disabled={resuming || !backendAvailable}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
            >
              <Play className="w-3 h-3" />
              {resuming ? 'Resuming...' : 'Resume'}
            </button>
          )}
          <button
            onClick={() => useAppStore.getState().toggleStandup()}
            className="flex items-center gap-1 px-2 py-0.5 rounded border border-amber-700/50 text-amber-400 hover:bg-amber-900/30 text-xs transition-colors"
          >
            <ClipboardList className="w-3 h-3" />
            View Standup
          </button>
          <button
            onClick={dismissPaused}
            className="text-amber-500/50 hover:text-amber-400 transition-colors"
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  // Neither active nor paused — don't render
  return null;
}
