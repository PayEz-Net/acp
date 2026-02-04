import { getSignalRClient, AgentMailSignalRClient } from './signalrClient';
import { useMailStore } from '../stores/mailStore';
import { useNotificationStore } from '../stores/notificationStore';
import { MailPushNotification, NotificationType } from '@shared/types';

/**
 * Mail Push Notification Service
 * 
 * Bridges SignalR push notifications to the application's
 * mail store and notification store. Handles:
 * - Connection management with auto-reconnect
 * - Agent subscriptions based on configured agents
 * - Notification routing to UI stores
 * - Sound/badges for high-priority events
 */

let pushServiceInstance: MailPushService | null = null;

export class MailPushService {
  private client: AgentMailSignalRClient | null = null;
  private isInitialized = false;
  private agentNames: string[] = [];

  /**
   * Initialize the push service
   * @param getAccessToken - Function to retrieve JWT
   * @param agentNames - List of agents to subscribe to
   */
  async initialize(
    getAccessToken: () => Promise<string | null>,
    agentNames: string[]
  ): Promise<void> {
    if (this.isInitialized) {
      console.log('[PushService] Already initialized');
      return;
    }

    this.agentNames = agentNames;

    try {
      this.client = getSignalRClient({
        getAccessToken,
        onNotification: this.handleNotification.bind(this),
        onStateChange: this.handleStateChange.bind(this),
        onSubscribed: this.handleSubscribed.bind(this),
        onError: this.handleError.bind(this),
      });

      await this.client.connect();
      
      // Subscribe to all configured agents
      if (agentNames.length > 0) {
        await this.client.subscribeToAgents(agentNames);
      }

      this.isInitialized = true;
      console.log('[PushService] Initialized and connected');

    } catch (error) {
      console.error('[PushService] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Disconnect and cleanup
   */
  async disconnect(): Promise<void> {
    this.isInitialized = false;
    
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
    
    console.log('[PushService] Disconnected');
  }

  /**
   * Update subscribed agents (e.g., after settings change)
   */
  async updateSubscribedAgents(agentNames: string[]): Promise<void> {
    if (!this.client || !this.isInitialized) return;

    // Unsubscribe from agents no longer in list
    const toRemove = this.agentNames.filter(a => !agentNames.includes(a));
    if (toRemove.length > 0) {
      await this.client.unsubscribeFromAgents(toRemove);
    }

    // Subscribe to new agents
    const toAdd = agentNames.filter(a => !this.agentNames.includes(a));
    if (toAdd.length > 0) {
      await this.client.subscribeToAgents(toAdd);
    }

    this.agentNames = [...agentNames];
  }

  /**
   * Get current connection status
   */
  getStatus() {
    return {
      state: this.client?.state || 'disconnected',
      isConnected: this.client?.isConnected || false,
      subscribedAgents: this.client?.subscribedAgentsList || [],
    };
  }

  /**
   * Handle incoming push notification
   */
  private handleNotification(notification: MailPushNotification): void {
    console.log('[PushService] Processing notification:', notification);

    const { data, event_type } = notification;
    const mailStore = useMailStore.getState();
    const notificationStore = useNotificationStore.getState();

    // 1. Refresh the inbox for the recipient agent
    // This ensures the mail list is up-to-date
    if (data.to_agent) {
      mailStore.fetchInbox(data.to_agent);
    }

    // 2. Add to notification store for UI badge/toast
    const notificationType = this.mapEventTypeToNotificationType(event_type);
    
    notificationStore.addNotification({
      type: notificationType,
      title: this.formatNotificationTitle(event_type, data.from_agent),
      message: data.subject || data.preview || 'New message',
      agent: data.from_agent,
      link: `/mail/${data.to_agent}/${data.message_id}`,
    });

    // 3. Play sound for high-priority notifications
    if (event_type === 'high_importance' || event_type === 'mention') {
      this.playNotificationSound();
    }

    // 4. Browser/Electron notification (if supported)
    this.showNativeNotification(notification);
  }

  /**
   * Handle connection state changes
   */
  private handleStateChange(state: string): void {
    console.log('[PushService] Connection state:', state);
    
    // Could update a global connection status store here
    // e.g., show "Reconnecting..." in UI
  }

  /**
   * Handle subscription confirmation
   */
  private handleSubscribed(subscribed: string[], denied: string[]): void {
    console.log('[PushService] Subscribed to:', subscribed);
    
    if (denied.length > 0) {
      console.warn('[PushService] Access denied to:', denied);
    }
  }

  /**
   * Handle errors
   */
  private handleError(error: Error): void {
    console.error('[PushService] Error:', error);
    
    // Add to notification store as system error
    const notificationStore = useNotificationStore.getState();
    notificationStore.addNotification({
      type: 'system',
      title: 'Mail Push Error',
      message: error.message || 'Failed to connect to push notifications',
    });
  }

  /**
   * Map push event type to notification store type
   */
  private mapEventTypeToNotificationType(eventType: string): NotificationType {
    switch (eventType) {
      case 'new_message':
      case 'agent_response':
        return 'mail';
      case 'mention':
        return 'mention';
      case 'high_importance':
        return 'mail';
      default:
        return 'system';
    }
  }

  /**
   * Format notification title based on event type
   */
  private formatNotificationTitle(eventType: string, fromAgent: string): string {
    switch (eventType) {
      case 'new_message':
        return `New message from ${fromAgent}`;
      case 'agent_response':
        return `${fromAgent} replied`;
      case 'mention':
        return `${fromAgent} mentioned you`;
      case 'high_importance':
        return `⚠️ Urgent: ${fromAgent}`;
      default:
        return `Message from ${fromAgent}`;
    }
  }

  /**
   * Play notification sound for high-priority events
   */
  private playNotificationSound(): void {
    try {
      // Use browser Audio API
      const audio = new Audio('/notification-sound.mp3');
      audio.volume = 0.5;
      audio.play().catch(() => {
        // Ignore autoplay restrictions
      });
    } catch {
      // Silent fail if audio not supported
    }
  }

  /**
   * Show native OS notification (if permitted)
   */
  private showNativeNotification(notification: MailPushNotification): void {
    if (!('Notification' in window)) return;
    
    if (Notification.permission === 'granted') {
      new Notification(this.formatNotificationTitle(notification.event_type, notification.data.from_agent), {
        body: notification.data.subject || notification.data.preview || 'New message',
        icon: '/icon.png',
      });
    } else if (Notification.permission !== 'denied') {
      // Request permission
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          this.showNativeNotification(notification);
        }
      });
    }
  }
}

/**
 * Get or create push service singleton
 */
export function getMailPushService(): MailPushService {
  if (!pushServiceInstance) {
    pushServiceInstance = new MailPushService();
  }
  return pushServiceInstance;
}

/**
 * Reset push service (for logout/re-auth)
 */
export async function resetMailPushService(): Promise<void> {
  if (pushServiceInstance) {
    await pushServiceInstance.disconnect();
    pushServiceInstance = null;
  }
}

/**
 * Initialize mail push notifications
 * Convenience function for components
 */
export async function initMailPush(
  getAccessToken: () => Promise<string | null>,
  agentNames: string[]
): Promise<MailPushService> {
  const service = getMailPushService();
  await service.initialize(getAccessToken, agentNames);
  return service;
}