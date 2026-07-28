import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { useProjectStore } from '../stores/projectStore';
import { useAgentOutputStore, isFrameBackedTerminal } from '../stores/agentOutputStore';
import { terminalStreamNormalizer, type StreamLine } from '../lib/terminalStream';
import { perfMark, perfMeasure } from '../lib/perf';

export type VsqlCacheConnectionState = 'connected' | 'reconnecting' | 'disconnected';

const BATCH_WINDOW_MS = 50;
const CONNECT_TIMEOUT_MS = 10000;

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
    // Use the shared normalizer so renderer lifecycle (kill/restart) can drop
    // per-terminal history and avoid stale frames bleeding into a new PTY.
    const streamNormalizer = terminalStreamNormalizer;

    async function connect() {
      if (disposed) return;

      const projectIdStr = projectId != null ? String(projectId) : '';
      if (!projectIdStr) {
        // PayEzVibe API stream requires projectId; wait until a project is active.
        setConn('disconnected');
        setTimeout(() => {
          if (!disposed) connect();
        }, 2000);
        return;
      }

      let token: string | null = null;
      let vibeApiUrl: string | null = null;
      try {
        token = await window.electronAPI.authGetAccessToken();
        if (!token) {
          throw new Error('no authenticated user token available');
        }
        const endpoints = await window.electronAPI.getCloudEndpoints();
        vibeApiUrl = endpoints.vibeApiUrl;
        if (!vibeApiUrl) {
          throw new Error('PayEzVibe API URL missing from cloud endpoints');
        }
      } catch (err) {
        console.error('[VsqlCacheSse] Failed to prepare stream connection:', err);
        setConn('disconnected');
        retryCount++;
        const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 30000) + Math.random() * 1000;
        setTimeout(() => {
          if (!disposed) connect();
        }, delay);
        return;
      }

      const path = '/v1/agent-output/stream';
      const params = new URLSearchParams();
      params.set('projectId', projectIdStr);
      if (agentsKey) {
        params.set('agents', agentsKey);
      }
      if (lastTsRef.current) {
        params.set('since', lastTsRef.current);
      }
      const url = `${vibeApiUrl}${path}?${params.toString()}`;
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      };

      console.log(`[VsqlCacheSse] Connecting... (attempt ${retryCount + 1})`);
      setConn('reconnecting');

      // Set when the 10s time-to-headers cap fires — lets the catch below
      // distinguish "server slow/stuck" from a mid-stream abort.
      let connectTimedOut = false;
      try {
        // AC6: cap time-to-headers at 10s so a stalled backend cannot hang
        // the reconnect path. The cap must NOT bound the stream's lifetime:
        // AbortSignal.timeout() keeps ticking after connect and would kill a
        // healthy SSE at the cap (that was the retry-116 AbortError loop).
        // Cloud cold starts can exceed 2s to first byte, hence 10s. Once
        // headers arrive the timer is cleared and only the lifecycle abortRef
        // governs the stream, so a clean disconnect/reset still cancels it.
        const connectAbort = new AbortController();
        const connectTimer = setTimeout(() => {
          connectTimedOut = true;
          connectAbort.abort();
        }, CONNECT_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(url, {
            headers,
            signal: AbortSignal.any([
              abortRef.current!.signal,
              connectAbort.signal,
            ]),
          });
        } finally {
          clearTimeout(connectTimer);
        }

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
                // Frame-backed terminals are driven by the local screen model
                // (useTerminalFrames). Skip their cloud rows entirely — the
                // normalizer must not see them (dedup state) and the pane must
                // not double-render them. lastTs still advances so reconnects
                // do not replay the skipped backlog.
                if (!isFrameBackedTerminal(line?.terminal_id)) {
                  const normalized = streamNormalizer.process(line);
                  const deferred = streamNormalizer.drain();
                  if (normalized) {
                    enqueue(normalized);
                  }
                  if (deferred) {
                    enqueue(deferred);
                  }
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
        if (connectTimedOut) {
          console.error(`[VsqlCacheSse] Connect timed out after ${CONNECT_TIMEOUT_MS}ms waiting for response headers (retry ${retryCount}, next in ${Math.round(delay)}ms) — backend slow or stuck, not the client`);
        } else {
          console.error(`[VsqlCacheSse] Error (retry ${retryCount}, next in ${Math.round(delay)}ms):`, err);
        }
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
