import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { useMailStore } from '../stores/mailStore';
import { usePartyStore } from '../stores/partyStore';
import { useAutonomyStore } from '../stores/autonomyStore';
import { useKanbanStore } from '../stores/kanbanStore';
import { useChatStore } from '../stores/chatStore';
import { useContractorStore } from '../stores/contractorStore';

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
  const { backendAvailable, agents, injectMessage } = useAppStore();
  const { fetchInbox } = useMailStore();
  const connectionStateRef = useRef<SseConnectionState>('disconnected');
  const lastPingRef = useRef<number>(0);

  useEffect(() => {
    console.log(`[AcpSse] Effect fired — backendAvailable: ${backendAvailable}, agents: ${agents.length}`);
    if (!backendAvailable) {
      console.log('[AcpSse] Skipping — backend not available');
      connectionStateRef.current = 'disconnected';
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let retryCount = 0;
    const MAX_RETRIES = 5;

    async function connect() {
      if (retryCount >= MAX_RETRIES) {
        console.warn('[AcpSse] Max retries reached, stopping');
        connectionStateRef.current = 'disconnected';
        return;
      }

      const secret = await getSecret();
      const headers: Record<string, string> = { 'Accept': 'text/event-stream' };
      if (secret) {
        headers['Authorization'] = `Bearer ${secret}`;
      }

      const url = 'http://127.0.0.1:3001/v1/sse/stream';
      console.log('[AcpSse] Connecting...');
      connectionStateRef.current = 'reconnecting';

      try {
        const response = await fetch(url, { headers, signal: controller.signal });

        if (!response.ok) {
          console.error(`[AcpSse] Connection failed: ${response.status}`);
          retryCount++;
          const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 30000);
          setTimeout(() => { if (!controller.signal.aborted) connect(); }, delay);
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        console.log('[AcpSse] Connected');
        connectionStateRef.current = 'connected';
        retryCount = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done || controller.signal.aborted) break;

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
                fetchInbox(agentName);
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
          }
        }

        // Stream ended — reconnect
        if (!controller.signal.aborted) {
          console.log('[AcpSse] Stream ended, reconnecting...');
          connectionStateRef.current = 'reconnecting';
          setTimeout(connect, 2000);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        retryCount++;
        connectionStateRef.current = 'reconnecting';
        const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 30000);
        console.error(`[AcpSse] Error (retry ${retryCount}/${MAX_RETRIES}):`, err);
        setTimeout(() => { if (!controller.signal.aborted) connect(); }, delay);
      }
    }

    connect();

    return () => {
      console.log('[AcpSse] Disconnecting');
      controller.abort();
      abortRef.current = null;
      connectionStateRef.current = 'disconnected';
    };
  }, [backendAvailable, agents, injectMessage, fetchInbox]);

  return {
    connectionState: connectionStateRef,
    lastPing: lastPingRef,
  };
}
