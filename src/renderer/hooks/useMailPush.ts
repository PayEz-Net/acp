import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { useMailStore } from '../stores/mailStore';

// Server sends snake_case fields
interface MailNotificationRaw {
  message_id?: number;
  messageId?: number;
  from_agent?: string;
  from?: string;
  subject?: string;
  created_at?: string;
  timestamp?: string;
}

/**
 * Format mail notification with ANSI colors for terminal display
 */
export function formatMailNotification(raw: MailNotificationRaw): string {
  const id = raw.message_id ?? raw.messageId ?? '?';
  const from = raw.from_agent ?? raw.from ?? 'unknown';
  const subject = raw.subject ?? '(no subject)';

  const lines = [
    '',
    '\x1b[35m╔════════════════════════════════════════════════════════╗\x1b[0m',
    `\x1b[35m║\x1b[0m  \x1b[1;35m[NEW MAIL]\x1b[0m ID: ${id}`,
    `\x1b[35m║\x1b[0m  From: \x1b[1;36m${from}\x1b[0m`,
    `\x1b[35m║\x1b[0m  Subject: ${subject}`,
    '\x1b[35m╠════════════════════════════════════════════════════════╣\x1b[0m',
    `\x1b[35m║\x1b[0m  \x1b[36mReply: /send-mail ${from} "RE: ${subject}"\x1b[0m`,
    `\x1b[35m║\x1b[0m  \x1b[36mRead:  /read-mail ${id}\x1b[0m`,
    '\x1b[35m╚════════════════════════════════════════════════════════╝\x1b[0m',
    '',
  ];
  return lines.map(line => line + '\r\n').join('');
}

// Get HMAC credentials (same source as mailStore)
let credentialsCache: { clientId: string; hmacKey: string } | null = null;

async function getCredentials(): Promise<{ clientId: string; hmacKey: string }> {
  if (credentialsCache) return credentialsCache;
  if (window.electronAPI?.getVibeCredentials) {
    try {
      const creds = await window.electronAPI.getVibeCredentials();
      credentialsCache = creds;
      return creds;
    } catch { /* fall through */ }
  }
  return { clientId: '', hmacKey: '' };
}

async function generateHmacSignature(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
  const messageData = encoder.encode(payload);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, messageData);
  const bytes = new Uint8Array(signature);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}

/**
 * Hook to subscribe to SSE mail push notifications for an agent.
 * Uses fetch() with HMAC auth headers instead of EventSource (which can't send headers).
 * When a notification arrives, it:
 *   1. Shows a visual banner in the xterm display
 *   2. Writes a "check inbox" command to PTY stdin so the Claude Code agent sees it
 *   3. Refreshes the mail sidebar
 */
export function useMailPush(agentName: string, enabled: boolean, terminalId?: string) {
  const abortRef = useRef<AbortController | null>(null);
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;
  const { mailPushUrl, injectMessage } = useAppStore();
  const { fetchInbox } = useMailStore();

  useEffect(() => {
    if (!enabled || !agentName) return;

    const controller = new AbortController();
    abortRef.current = controller;
    let retryCount = 0;
    const MAX_RETRIES = 5;

    async function connectSSE() {
      if (retryCount >= MAX_RETRIES) {
        console.warn(`[MailPush] Max retries (${MAX_RETRIES}) reached for ${agentName}, stopping SSE`);
        return;
      }

      const endpoint = `/v1/agentmail/stream?agent=${encodeURIComponent(agentName)}`;
      const url = `${mailPushUrl}${endpoint}`;

      // Build HMAC auth headers
      const { clientId, hmacKey } = await getCredentials();
      console.log(`[MailPush] Credentials: clientId=${clientId || '(empty)'}, hmacKey=${hmacKey ? '(set)' : '(empty)'}`);
      const headers: Record<string, string> = { 'Accept': 'text/event-stream' };

      if (clientId && hmacKey) {
        const timestamp = Math.floor(Date.now() / 1000);
        const signaturePayload = `${timestamp}|GET|${endpoint.split('?')[0]}`;
        try {
          const signature = await generateHmacSignature(hmacKey, signaturePayload);
          headers['X-Vibe-Client-Id'] = clientId;
          headers['X-Vibe-Timestamp'] = timestamp.toString();
          headers['X-Vibe-Signature'] = signature;
        } catch (err) {
          console.error('[MailPush] HMAC signature failed:', err);
        }
      }

      console.log(`[MailPush] Connecting SSE for ${agentName}: ${url}`);

      try {
        const response = await fetch(url, {
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          console.error(`[MailPush] SSE connection failed for ${agentName}: ${response.status}`);
          retryCount++;
          const delay = Math.min(10000 * Math.pow(2, retryCount - 1), 60000);
          setTimeout(() => {
            if (!controller.signal.aborted) connectSSE();
          }, delay);
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        console.log(`[MailPush] SSE connected for ${agentName}`);
        retryCount = 0; // Reset on successful connection

        while (true) {
          const { done, value } = await reader.read();
          if (done || controller.signal.aborted) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events from buffer
          const events = buffer.split('\n\n');
          buffer = events.pop() || ''; // Keep incomplete event in buffer

          for (const eventBlock of events) {
            const lines = eventBlock.split('\n');
            let eventType = '';
            let data = '';

            for (const line of lines) {
              if (line.startsWith('event: ')) eventType = line.slice(7).trim();
              else if (line.startsWith('data: ')) data += line.slice(6);
              else if (line.startsWith('data:')) data += line.slice(5);
            }

            if ((eventType === 'new-mail' || eventType === '') && data) {
              try {
                const mail: MailNotificationRaw = JSON.parse(data);
                const id = mail.message_id ?? mail.messageId;

                // Skip events without a valid message ID (heartbeats, connection acks)
                if (!id) continue;

                console.log(`[MailPush] New mail for ${agentName}:`, JSON.stringify(mail));

                // 1. Write to PTY stdin so Claude Code agent sees the mail
                if (terminalIdRef.current) {
                  const from = mail.from_agent ?? mail.from ?? 'unknown';
                  const subject = mail.subject ?? '';
                  const cmd = `check inbox - new mail from ${from}: "${subject}" (ID: ${id})`;
                  // Small delay to avoid garbling with any in-flight output
                  setTimeout(() => {
                    window.electronAPI.writeTerminal(terminalIdRef.current!, cmd + '\r');
                  }, 500);
                }

                // 3. Refresh mail sidebar
                fetchInbox(agentName);
              } catch (err) {
                console.error('[MailPush] Failed to parse mail event:', err);
              }
            } else if (eventType === 'heartbeat' || eventType === 'ping') {
              // Keep-alive, ignore
            }
          }
        }

        // Stream ended — reconnect unless aborted
        if (!controller.signal.aborted) {
          console.log(`[MailPush] SSE stream ended for ${agentName}, reconnecting...`);
          setTimeout(connectSSE, 5000);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        retryCount++;
        const delay = Math.min(10000 * Math.pow(2, retryCount - 1), 60000);
        console.error(`[MailPush] SSE error for ${agentName} (retry ${retryCount}/${MAX_RETRIES}):`, err);
        setTimeout(() => {
          if (!controller.signal.aborted) connectSSE();
        }, delay);
      }
    }

    connectSSE();

    return () => {
      console.log(`[MailPush] Closing SSE for ${agentName}`);
      controller.abort();
      abortRef.current = null;
    };
  }, [agentName, enabled, mailPushUrl, injectMessage, fetchInbox]);
}
