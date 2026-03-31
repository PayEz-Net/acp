import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { useMailStore } from '../stores/mailStore';
import { usePartyStore } from '../stores/partyStore';
import { useAutonomyStore } from '../stores/autonomyStore';
import { useKanbanStore } from '../stores/kanbanStore';
import { useChatStore } from '../stores/chatStore';
import { useContractorStore } from '../stores/contractorStore';
import { useProjectStore } from '../stores/projectStore';

/**
 * Centralized SSE hook — single connection to acp-api, multiplexed by agent.
 * Replaces per-pane useMailPush (Phase 1b).
 *
 * Events from acp-api:
 *   event: mail    data: { agent, message_id, from_agent, subject, ... }
 *   event: ping    data: {}
 */

interface SseMailEvent {
  agent: string;
  message_id?: number;
  from_agent?: string;
  from?: string;
  subject?: string;
}

export type SseConnectionState = 'connected' | 'reconnecting' | 'disconnected';

// Cache the local secret
let secretCache: string | null = null;

async function getSecret(): Promise<string | null> {
  if (secretCache) return secretCache;
  if (window.electronAPI?.getLocalSecret) {
    try {
      secretCache = await window.electronAPI.getLocalSecret();
      return secretCache;
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Single SSE connection to acp-api /v1/sse/stream.
 * Routes mail events to the correct agent's PTY pane.
 * Call once at App level (not per-pane).
 */
export function useAcpSse() {
  const abortRef = useRef<AbortController | null>(null);
  // Only subscribe to backendAvailable — agent status changes must NOT reconnect SSE
  const backendAvailable = useAppStore(s => s.backendAvailable);
  const connectionStateRef = useRef<SseConnectionState>('disconnected');
  const lastPingRef = useRef<number>(0);

  useEffect(() => {
    console.log(`[AcpSse] Effect fired — backendAvailable: ${backendAvailable}`);
    if (!backendAvailable) {
      console.log('[AcpSse] Skipping — backend not available');
      connectionStateRef.current = 'disconnected';
      return;
    }

    let disposed = false;
    abortRef.current = new AbortController();
    let retryCount = 0;

    // P0: Stale ping watchdog — force reconnect if no ping for 60s
    const STALE_PING_MS = 60_000;
    const pingWatchdog = setInterval(() => {
      if (disposed) return;
      const last = lastPingRef.current;
      if (last > 0 && Date.now() - last > STALE_PING_MS && connectionStateRef.current === 'connected') {
        console.warn(`[AcpSse] No ping for ${Math.round((Date.now() - last) / 1000)}s — forcing reconnect`);
        abortRef.current?.abort();
        abortRef.current = new AbortController();
        connect();
      }
    }, 15_000);

    async function connect() {
      if (disposed) return;
      // P3: No hard retry limit — exponential backoff with 30s cap, never give up
      const secret = await getSecret();
      const headers: Record<string, string> = { 'Accept': 'text/event-stream' };
      if (secret) {
        headers['Authorization'] = `Bearer ${secret}`;
      }

      const url = 'http://127.0.0.1:3001/v1/sse/stream';
      console.log(`[AcpSse] Connecting... (attempt ${retryCount + 1})`);
      connectionStateRef.current = 'reconnecting';

      try {
        const response = await fetch(url, { headers, signal: abortRef.current!.signal });

        if (!response.ok) {
          console.error(`[AcpSse] Connection failed: ${response.status}`);
          retryCount++;
          const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 30000) + Math.random() * 1000;
          setTimeout(() => { if (!disposed) connect(); }, delay);
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        console.log('[AcpSse] Connected');
        connectionStateRef.current = 'connected';
        retryCount = 0;
        lastPingRef.current = Date.now(); // treat connect as implicit ping

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

            if (eventType === 'ping') {
              lastPingRef.current = Date.now();
              continue;
            }

            if (eventType === 'mail' && data) {
              try {
                const mail: SseMailEvent = JSON.parse(data);
                const agentName = mail.agent;
                if (!agentName) continue;

                const id = mail.message_id ?? '?';
                const from = mail.from_agent ?? mail.from ?? 'unknown';
                const subject = mail.subject ?? '(no subject)';

                console.log(`[AcpSse] Mail for ${agentName}: ${from} — ${subject}`);

                // Find the agent's terminalId and write to PTY
                const agentState = useAppStore.getState().agents.find(a => a.name === agentName);
                if (agentState?.terminalId) {
                  const cmd = `check inbox - new mail from ${from}: "${subject}" (ID: ${id})`;
                  setTimeout(() => {
                    window.electronAPI.writeTerminal(agentState.terminalId!, cmd + '\r');
                  }, 500);
                }

                // Refresh mail sidebar
                useMailStore.getState().fetchInbox(agentName);
              } catch (err) {
                console.error('[AcpSse] Failed to parse mail event:', err);
              }
            }

            // Phase 3: Party engine updates
            if (eventType === 'party-update' && data) {
              try {
                usePartyStore.getState().updateFromSse(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse party event:', err);
              }
            }

            // Phase 3: Autonomy updates
            if (eventType === 'autonomy-update' && data) {
              try {
                useAutonomyStore.getState().updateFromSse(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse autonomy event:', err);
              }
            }

            // Phase 4: Kanban updates
            if (eventType === 'kanban-update' && data) {
              try {
                useKanbanStore.getState().updateFromSse(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse kanban event:', err);
              }
            }

            // Phase 4: Chat messages
            if (eventType === 'chat-message' && data) {
              try {
                useChatStore.getState().updateFromSse(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse chat event:', err);
              }
            }

            // Contractor events
            if (eventType === 'contractor-hired' && data) {
              try {
                useContractorStore.getState().handleContractorHired(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-hired event:', err);
              }
            }

            if (eventType === 'contractor-completed' && data) {
              try {
                useContractorStore.getState().handleContractorCompleted(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-completed event:', err);
              }
            }

            if (eventType === 'contractor-expired' && data) {
              try {
                useContractorStore.getState().handleContractorExpired(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-expired event:', err);
              }
            }

            if (eventType === 'contractor-cancelled' && data) {
              try {
                useContractorStore.getState().handleContractorCancelled(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-cancelled event:', err);
              }
            }

            if (eventType === 'contractor-queued' && data) {
              try {
                useContractorStore.getState().handleContractorQueued(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-queued event:', err);
              }
            }

            if (eventType === 'contractor-mailbox-assigned' && data) {
              try {
                useContractorStore.getState().handleContractorMailboxAssigned(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-mailbox-assigned event:', err);
              }
            }

            if (eventType === 'contractor-promoted' && data) {
              try {
                useContractorStore.getState().handleContractorPromoted(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-promoted event:', err);
              }
            }

            if (eventType === 'session-started' && data) {
              try {
                useContractorStore.getState().handleSessionStarted(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse session-started event:', err);
              }
            }

            if (eventType === 'session-output' && data) {
              try {
                useContractorStore.getState().handleSessionOutput(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse session-output event:', err);
              }
            }

            if (eventType === 'session-exited' && data) {
              try {
                useContractorStore.getState().handleSessionExited(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse session-exited event:', err);
              }
            }

            if (eventType === 'project-switched' && data) {
              try {
                useProjectStore.getState().handleProjectSwitched(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse project-switched event:', err);
              }
            }

            // Unattended mode events
            if ((eventType === 'unattended-started' || eventType === 'unattended-paused') && data) {
              try {
                useAutonomyStore.getState().updateFromSse(JSON.parse(data));
              } catch (err) {
                console.error(`[AcpSse] Failed to parse ${eventType} event:`, err);
              }
            }
          }
        }

        // Stream ended — reconnect
        if (!disposed) {
          console.log('[AcpSse] Stream ended, reconnecting...');
          connectionStateRef.current = 'reconnecting';
          abortRef.current = new AbortController();
          setTimeout(connect, 2000);
        }
      } catch (err) {
        if (disposed) return;
        retryCount++;
        connectionStateRef.current = 'reconnecting';
        abortRef.current = new AbortController();
        const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 30000) + Math.random() * 1000;
        console.error(`[AcpSse] Error (retry ${retryCount}, next in ${Math.round(delay)}ms):`, err);
        setTimeout(() => { if (!disposed) connect(); }, delay);
      }
    }

    connect();

    return () => {
      console.log('[AcpSse] Disconnecting');
      disposed = true;
      clearInterval(pingWatchdog);
      abortRef.current?.abort();
      abortRef.current = null;
      connectionStateRef.current = 'disconnected';
    };
  }, [backendAvailable]);

  return {
    connectionState: connectionStateRef,
    lastPing: lastPingRef,
  };
}
