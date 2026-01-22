import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';

interface MailNotification {
  messageId: number;
  from: string;
  subject: string;
  timestamp: string;
}

/**
 * Format mail notification with ANSI colors for terminal display
 */
function formatMailNotification(mail: MailNotification): string {
  const lines = [
    '',
    '\x1b[35m╔════════════════════════════════════════════════════════╗\x1b[0m',
    `\x1b[35m║\x1b[0m  \x1b[1;35m[NEW MAIL]\x1b[0m ID: ${mail.messageId}`,
    `\x1b[35m║\x1b[0m  From: \x1b[1;36m${mail.from}\x1b[0m`,
    `\x1b[35m║\x1b[0m  Subject: ${mail.subject}`,
    '\x1b[35m╠════════════════════════════════════════════════════════╣\x1b[0m',
    `\x1b[35m║\x1b[0m  \x1b[36mReply: /send-mail ${mail.from} "RE: ${mail.subject}"\x1b[0m`,
    `\x1b[35m║\x1b[0m  \x1b[36mRead:  /read-mail ${mail.messageId}\x1b[0m`,
    '\x1b[35m╚════════════════════════════════════════════════════════╝\x1b[0m',
    '',
  ];
  return lines.map(line => line + '\r\n').join('');
}

/**
 * Hook to subscribe to SSE mail push notifications for an agent
 */
export function useMailPush(agentName: string, enabled: boolean) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const { mailPushUrl, injectMessage } = useAppStore();

  useEffect(() => {
    // Don't subscribe if disabled or no agent name
    if (!enabled || !agentName) {
      return;
    }

    const url = `${mailPushUrl}/v1/agentmail/stream?agent=${encodeURIComponent(agentName)}`;

    console.log(`[MailPush] Connecting to SSE for ${agentName}: ${url}`);

    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('new-mail', (event) => {
      try {
        const mail: MailNotification = JSON.parse(event.data);
        console.log(`[MailPush] New mail for ${agentName}:`, mail);

        const message = formatMailNotification(mail);
        injectMessage(agentName, message);
      } catch (err) {
        console.error('[MailPush] Failed to parse mail event:', err);
      }
    });

    eventSource.onopen = () => {
      console.log(`[MailPush] SSE connected for ${agentName}`);
    };

    eventSource.onerror = (err) => {
      console.error(`[MailPush] SSE error for ${agentName}:`, err);
      // EventSource will automatically reconnect
    };

    // Cleanup on unmount or when dependencies change
    return () => {
      console.log(`[MailPush] Closing SSE for ${agentName}`);
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, [agentName, enabled, mailPushUrl, injectMessage]);

  return eventSourceRef.current;
}
