import { useEffect, useState, useRef } from 'react';
import { useAppStore } from '../../stores/appStore';
import { X, Pause, Play, Filter } from 'lucide-react';

interface LogViewerProps {
  isOpen: boolean;
  onClose: () => void;
}

type LogLevel = 'all' | 'error' | 'warn' | 'info';

export function LogViewer({ isOpen, onClose }: LogViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<LogLevel>('all');
  const scrollRef = useRef<HTMLDivElement>(null);
  const { backendAvailable } = useAppStore();

  // Poll logs every 2s
  useEffect(() => {
    if (!isOpen || paused) return;
    const fetchLogs = async () => {
      if (window.electronAPI?.getApiLogs) {
        const lines = await window.electronAPI.getApiLogs();
        setLogs(lines);
      }
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [isOpen, paused]);

  // Auto-scroll
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, paused]);

  if (!isOpen) return null;

  const filtered = logs.filter((line) => {
    if (level === 'all') return true;
    if (level === 'error') return line.includes('[err]') || line.toLowerCase().includes('error');
    if (level === 'warn') return line.toLowerCase().includes('warn') || line.includes('[err]');
    return true;
  });

  return (
    <div className="w-96 bg-slate-900 border-l border-slate-700 flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <span className="text-sm font-semibold text-slate-200">API Logs</span>
        <div className="flex items-center gap-2">
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as LogLevel)}
            className="text-xs bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-300"
          >
            <option value="all">All</option>
            <option value="error">Errors</option>
            <option value="warn">Warn+</option>
            <option value="info">Info</option>
          </select>
          <button onClick={() => setPaused(!paused)} className="text-slate-400 hover:text-white" title={paused ? 'Resume' : 'Pause'}>
            {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
          </button>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 font-mono text-xs">
        {!backendAvailable ? (
          <div className="text-slate-500 text-center py-4">Backend not running</div>
        ) : filtered.length === 0 ? (
          <div className="text-slate-500 text-center py-4">No logs</div>
        ) : (
          filtered.map((line, i) => (
            <div
              key={i}
              className={`py-0.5 ${
                line.includes('[err]') ? 'text-red-400' :
                line.toLowerCase().includes('warn') ? 'text-amber-400' :
                'text-slate-400'
              }`}
            >
              {line}
            </div>
          ))
        )}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-xs text-slate-500">
        {filtered.length} lines {paused && '(paused)'}
      </div>
    </div>
  );
}
