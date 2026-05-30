import { useState, useEffect } from 'react';
import { WifiOff, RefreshCw, X } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';

export function BackendStatusBanner() {
  const { backendAvailable } = useAppStore();
  const [retrying, setRetrying] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Auto-clear dismissal when backend comes back so we re-show on next disconnect
  useEffect(() => {
    if (backendAvailable && dismissed) {
      setDismissed(false);
    }
  }, [backendAvailable, dismissed]);

  if (backendAvailable) return null;
  if (dismissed) return null;

  const handleRetry = async () => {
    if (!window.electronAPI?.retryBackend) return;
    setRetrying(true);
    try {
      await window.electronAPI.retryBackend();
    } catch (err) {
      console.error('[BackendStatusBanner] Retry failed:', err);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="h-8 bg-amber-950/80 border-b border-amber-800/50 flex items-center justify-between px-4 text-xs">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <WifiOff className="w-3 h-3 text-amber-400" />
          <span className="font-semibold text-amber-400">OFFLINE</span>
        </div>
        <div className="w-px h-3.5 bg-amber-800/50" />
        <span className="text-amber-300/70">
          Couldn&apos;t reach ACP backend — some features are unavailable.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-700/40 hover:bg-amber-700/60 disabled:opacity-50 text-amber-200 text-xs font-medium transition-colors"
        >
          <RefreshCw className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`} />
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="text-amber-500/50 hover:text-amber-400 transition-colors"
          title="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
