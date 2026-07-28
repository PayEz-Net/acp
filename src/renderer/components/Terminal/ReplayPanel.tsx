import { useEffect, useState, useCallback } from 'react';
import { X, Download, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import type {
  TerminalReplayLine,
  TerminalReplaySession,
  TerminalReplayHistoryResult,
} from '@shared/types';

export function ReplayPanel() {
  const { showReplay, toggleReplay } = useAppStore();
  const { activeProject } = useProjectStore();
  const projectId = activeProject?.id;

  const [lines, setLines] = useState<TerminalReplayLine[]>([]);
  const [sessions, setSessions] = useState<TerminalReplaySession[]>([]);
  const [selectedSession, setSelectedSession] = useState<string>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    if (!projectId || !window.electronAPI?.loadTerminalSessions) return;
    try {
      const result = await window.electronAPI.loadTerminalSessions(projectId);
      setSessions(result.sessions ?? []);
    } catch (e) {
      console.error('[ReplayPanel] load sessions failed:', e);
    }
  }, [projectId]);

  const loadHistory = useCallback(async (nextCursor?: string) => {
    if (!projectId || !window.electronAPI?.loadTerminalHistory) return;
    setLoading(true);
    setError(null);
    try {
      const result: TerminalReplayHistoryResult = await window.electronAPI.loadTerminalHistory({
        projectId,
        sessionId: selectedSession || undefined,
        cursor: nextCursor,
        limit: 100,
      });
      if (nextCursor) {
        setLines((prev) => [...prev, ...(result.lines ?? [])]);
      } else {
        setLines(result.lines ?? []);
      }
      setCursor(result.next_cursor);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedSession]);

  useEffect(() => {
    if (!showReplay) return;
    loadSessions();
    loadHistory();
  }, [showReplay, loadSessions, loadHistory]);

  const handleExport = async (format: 'ndjson' | 'json') => {
    if (!projectId || !window.electronAPI?.loadTerminalExport) return;
    try {
      const { blob, filename } = await window.electronAPI.loadTerminalExport({
        projectId,
        format,
        sessionId: selectedSession || undefined,
      });
      const element = document.createElement('a');
      const file = new Blob([blob], { type: format === 'ndjson' ? 'application/x-ndjson' : 'application/json' });
      element.href = URL.createObjectURL(file);
      element.download = filename;
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);
    } catch (e) {
      setError(`Export failed: ${e}`);
    }
  };

  if (!showReplay) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[90vw] h-[80vh] bg-acp-surface border border-acp-border rounded-lg flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-acp-border">
          <h2 className="text-sm font-semibold text-acp-text-primary">
            Terminal Replay {projectId ? `(project ${projectId})` : '(no active project)'}
          </h2>
          <button onClick={toggleReplay} className="text-acp-text-secondary hover:text-acp-text-primary">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 border-b border-acp-border">
          <select
            value={selectedSession}
            onChange={(e) => setSelectedSession(e.target.value)}
            className="bg-acp-bg border border-acp-border rounded px-2 py-1 text-xs text-acp-text-primary"
          >
            <option value="">All sessions</option>
            {sessions.map((s) => (
              <option key={s.session_id} value={s.session_id}>
                {s.agent} / {s.terminal_id.slice(0, 8)}… ({new Date(s.first_ts).toLocaleString()})
              </option>
            ))}
          </select>
          <button
            onClick={() => loadHistory()}
            disabled={loading}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-acp-accent text-white disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => handleExport('ndjson')}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-acp-surface-raised text-acp-text-primary hover:bg-acp-border"
          >
            <Download className="w-3 h-3" />
            NDJSON
          </button>
          <button
            onClick={() => handleExport('json')}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-acp-surface-raised text-acp-text-primary hover:bg-acp-border"
          >
            <Download className="w-3 h-3" />
            JSON
          </button>
        </div>

        {error && (
          <div className="px-4 py-2 text-xs text-acp-status-error bg-acp-status-error/10">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-auto p-4 font-mono text-xs">
          {lines.length === 0 && !loading && (
            <p className="text-acp-text-secondary">No replay lines found.</p>
          )}
          {lines.map((line, idx) => (
            <div key={idx} className="py-0.5 border-b border-acp-border/30">
              <span className="text-acp-text-secondary">{new Date(line.ts).toLocaleTimeString()}</span>
              {' '}
              <span className="text-acp-accent">{line.agent}</span>
              {' '}
              <span className="text-acp-text-primary whitespace-pre-wrap">{line.line}</span>
            </div>
          ))}
          {cursor && (
            <button
              onClick={() => loadHistory(cursor)}
              disabled={loading}
              className="mt-2 px-3 py-1 text-xs rounded bg-acp-surface-raised text-acp-text-primary hover:bg-acp-border disabled:opacity-50"
            >
              Load more
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
