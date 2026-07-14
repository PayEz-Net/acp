import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { useProjectStore } from '../stores/projectStore';
import { useAgentOutputStore } from '../stores/agentOutputStore';
import { terminalStreamNormalizer, type StreamLine } from '../lib/terminalStream';
import { perfMark, perfMeasure } from '../lib/perf';

export type VsqlCacheConnectionState = 'connected' | 'reconnecting' | 'disconnected';

const BATCH_WINDOW_MS = 50;

export function useVsqlCacheSse(): {
  connectionState: React.MutableRefObject<VsqlCacheConnectionState>;
} {
  const abortRef = useRef<AbortController | null>(null);
  const connectionStateRef = useRef<VsqlCacheConnectionState>('disconnected');
  const lastTsRef = useRef<string | null>(null);
  const batchRef = useRef<StreamLine[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const backendAvailable = useAppStore((s) => s.backendAvailable);
  const projectId = useProjectStore((s) => s.activeProject?.id);
  const pickerHasStarted = useProjectStore((s) => s.pickerHasStarted);
  const agents = useAppStore((s) => s.agents.map((a) => a.name));
  const projectTeamAgents = useProjectStore((s) => s.currentProjectTeam.map((m) => m.agent_name));
  const agentsKey = agents.length > 0 ? agents.join(',') : projectTeamAgents.join(',');

  useEffect(() => {
    const setConn = (s: VsqlCacheConnectionState) => {
      connectionStateRef.current = s;
    };

    const flushBatch = () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      const batch = batchRef.current;
      if (batch.length === 0) return;
      batchRef.current = [];
      const start = perfMark('vsql-batch-flush', { count: batch.length });
      useAgentOutputStore.getState().addLines(batch);
      perfMeasure('vsql-batch-flush', start, { count: batch.length });
    };

    const scheduleFlush = () => {
      if (batchTimerRef.current) return;
      batchTimerRef.current = setTimeout(flushBatch, BATCH_WINDOW_MS);
    };

    const enqueue = (line: StreamLine) => {
      batchRef.current.push(line);
      scheduleFlush();
    };

    if (!backendAvailable || !pickerHasStarted || !agentsKey) {
      flushBatch();
      setConn('disconnected');
      return;
    }

    let disposed = false;
    abortRef.current = new AbortController();
    let retryCount = 0;
    let vsqlCacheBaseUrl = '';
    // Use the shared normalizer so renderer lifecycle (kill/restart) can drop
    // per-terminal history and avoid stale frames bleeding into a new PTY.
    const streamNormalizer = terminalStreamNormalizer;

    async function connect() {
      if (disposed) return;

      const projectIdStr = projectId != null ? String(projectId) : '';
      if (!projectIdStr) {
        // vsql-cache requires projectId; wait until a project is active.
        setConn('disconnected');
        setTimeout(() => {
          if (!disposed) connect();
        }, 2000);
        return;
      }

      const path = '/v1/agent-output/stream';
      let authHeaders: Record<string, string | boolean> = {};
      try {
        const rawAuthHeaders = (await window.electronAPI.getVsqlCacheAuthHeaders('GET', path)) || {};
        if (rawAuthHeaders.error) {
          throw new Error(`auth headers error: ${rawAuthHeaders.error}`);
        }
        if (rawAuthHeaders.disabled) {
          // vsql-cache reporting is disabled in the main process. Stay
          // disconnected and do not retry — otherwise we would spam the log.
          setConn('disconnected');
          return;
        }

        const { url: cacheBaseUrl, ...authHeaderEntries } = rawAuthHeaders;
        if (!cacheBaseUrl || typeof cacheBaseUrl !== 'string') {
          throw new Error('vsql-cache base URL missing from main process response');
        }

        vsqlCacheBaseUrl = cacheBaseUrl;
        authHeaders = authHeaderEntries;
      } catch (err) {
        console.error('[VsqlCacheSse] Failed to build auth headers:', err);
        setConn('disconnected');
        retryCount++;
        const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 30000) + Math.random() * 1000;
        setTimeout(() => {
          if (!disposed) connect();
        }, delay);
        return;
      }

      if (!vsqlCacheBaseUrl) {
        // Defensive: should have thrown above, but keep TypeScript narrow.
        setConn('disconnected');
        return;
      }

      const sessionTokenResult = await window.electronAPI.getActiveSessionToken(Number(projectIdStr));
      if (sessionTokenResult.error) {
        console.error('[VsqlCacheSse] Failed to get active session token:', sessionTokenResult.error);
      }

      const params = new URLSearchParams();
      params.set('projectId', projectIdStr);
      if (agentsKey) {
        params.set('agents', agentsKey);
      }
      if (lastTsRef.current) {
        params.set('since', lastTsRef.current);
      }
      const url = `${vsqlCacheBaseUrl}${path}?${params.toString()}`;
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        'X-Vibe-Project-Id': projectIdStr,
        ...(authHeaders as Record<string, string>),
      };
      if (sessionTokenResult.token) {
        headers['X-Session-Token'] = sessionTokenResult.token;
      }

      console.log(`[VsqlCacheSse] Connecting... (attempt ${retryCount + 1})`);
      setConn('reconnecting');

      try {
        const response = await fetch(url, {
          headers,
          signal: abortRef.current!.signal,
        });

        if (!response.ok) {
          console.error(`[VsqlCacheSse] Connection failed: ${response.status}`);
          setConn('disconnected');
          retryCount++;
          const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 30000) + Math.random() * 1000;
          setTimeout(() => {
            if (!disposed) connect();
          }, delay);
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        console.log('[VsqlCacheSse] Connected');
        setConn('connected');
        retryCount = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done || disposed) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';

          for (const eventBlock of events) {
            const lines = eventBlock.split('\n');
            let eventType = '';
            let data = '';

            for (const line of lines) {
              if (line.startsWith('event: ')) eventType = line.slice(7).trim();
              else if (line.startsWith('data: ')) data += line.slice(6);
              else if (line.startsWith('data:')) data += line.slice(5);
            }

            if (eventType === 'agent-output' && data) {
              try {
                const line = JSON.parse(data);
                const normalized = streamNormalizer.process(line);
                const deferred = streamNormalizer.drain();
                if (normalized) {
                  enqueue(normalized);
                }
                if (deferred) {
                  enqueue(deferred);
                }
                if (line.ts && typeof line.ts === 'string') {
                  lastTsRef.current = line.ts;
                }
              } catch (err) {
                console.error('[VsqlCacheSse] Failed to parse agent-output event:', err);
              }
            }
          }
        }

        if (!disposed) {
          console.log('[VsqlCacheSse] Stream ended, reconnecting...');
          flushBatch();
          setConn('reconnecting');
          abortRef.current = new AbortController();
          setTimeout(connect, 2000);
        }
      } catch (err) {
        if (disposed) return;
        flushBatch();
        retryCount++;
        setConn('reconnecting');
        abortRef.current = new AbortController();
        const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 30000) + Math.random() * 1000;
        console.error(`[VsqlCacheSse] Error (retry ${retryCount}, next in ${Math.round(delay)}ms):`, err);
        setTimeout(() => {
          if (!disposed) connect();
        }, delay);
      }
    }

    connect();

    return () => {
      console.log('[VsqlCacheSse] Disconnecting');
      disposed = true;
      flushBatch();
      abortRef.current?.abort();
      abortRef.current = null;
      setConn('disconnected');
    };
  }, [backendAvailable, projectId, agentsKey, pickerHasStarted]);

  return { connectionState: connectionStateRef };
}
