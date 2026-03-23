import * as signalR from '@microsoft/signalr';
import { MailPushNotification } from '@shared/types';

const HUB_URL = 'https://api.idealvibe.online/hubs/agentmail';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface SignalRClientOptions {
  /** Function to get JWT access token */
  getAccessToken: () => Promise<string | null>;
  /** Callback when notification received */
  onNotification?: (notification: MailPushNotification) => void;
  /** Callback when connection state changes */
  onStateChange?: (state: ConnectionState) => void;
  /** Callback when subscribed to agents */
  onSubscribed?: (agents: string[], denied: string[]) => void;
  /** Callback for errors */
  onError?: (error: Error) => void;
}

/**
 * SignalR client for Agent Mail push notifications
 * Manages WebSocket connection, auto-reconnect, and agent subscriptions
 */
export class AgentMailSignalRClient {
  private connection: signalR.HubConnection | null = null;
  private options: SignalRClientOptions;
  private subscribedAgents: Set<string> = new Set();
  private currentState: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;

  constructor(options: SignalRClientOptions) {
    this.options = options;
  }

  /**
   * Get current connection state
   */
  get state(): ConnectionState {
    return this.currentState;
  }

  /**
   * Check if connected to hub
   */
  get isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }

  /**
   * Get list of subscribed agents
   */
  get subscribedAgentsList(): string[] {
    return Array.from(this.subscribedAgents);
  }

  private lastToken: string | null = null;
  private tokenRefreshTimer: number | null = null;

  /**
   * Start background token refresh (every 45 minutes)
   * This ensures token is always fresh before SignalR needs it
   */
  private startTokenRefreshTimer(): void {
    this.stopTokenRefreshTimer();
    // Refresh every 45 minutes (tokens typically last 1 hour)
    this.tokenRefreshTimer = window.setInterval(async () => {
      if (this.isConnected) {
        console.log('[SignalR] Proactive token refresh...');
        try {
          const freshToken = await this.options.getAccessToken();
          if (freshToken) {
            this.lastToken = freshToken;
            console.log('[SignalR] Token refreshed proactively');
          }
        } catch (error) {
          console.error('[SignalR] Proactive token refresh failed:', error);
        }
      }
    }, 45 * 60 * 1000); // 45 minutes
  }

  /**
   * Stop background token refresh
   */
  private stopTokenRefreshTimer(): void {
    if (this.tokenRefreshTimer) {
      window.clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
  }

  /**
   * Connect to SignalR hub
   */
  async connect(): Promise<void> {
    if (this.connection?.state === signalR.HubConnectionState.Connected) {
      console.log('[SignalR] Already connected');
      return;
    }

    this.setState('connecting');

    try {
      // Get initial token
      const token = await this.options.getAccessToken();
      if (!token) {
        throw new Error('No access token available');
      }
      this.lastToken = token;

      this.connection = new signalR.HubConnectionBuilder()
        .withUrl(HUB_URL, {
          // Always return fresh token - called on each connect/reconnect
          accessTokenFactory: async () => {
            const freshToken = await this.options.getAccessToken();
            if (freshToken) {
              this.lastToken = freshToken;
            }
            return this.lastToken || '';
          },
          transport: signalR.HttpTransportType.WebSockets | 
                     signalR.HttpTransportType.ServerSentEvents |
                     signalR.HttpTransportType.LongPolling
        })
        .withAutomaticReconnect({
          nextRetryDelayInMilliseconds: (retryContext) => {
            // Exponential backoff: 0, 2s, 5s, 10s, 30s, then 30s forever
            const delays = [0, 2000, 5000, 10000, 30000];
            const delay = delays[Math.min(retryContext.previousRetryCount, delays.length - 1)];
            console.log(`[SignalR] Reconnecting in ${delay}ms (attempt ${retryContext.previousRetryCount + 1})`);
            return delay;
          }
        })
        .configureLogging(signalR.LogLevel.Information)
        .build();

      this.setupEventHandlers();

      await this.connection.start();
      console.log('[SignalR] Connected to hub');
      this.setState('connected');
      this.reconnectAttempts = 0;

      // Start proactive token refresh
      this.startTokenRefreshTimer();

    } catch (error) {
      console.error('[SignalR] Connection failed:', error);
      this.setState('disconnected');
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Disconnect from hub
   */
  async disconnect(): Promise<void> {
    this.stopTokenRefreshTimer();
    this.subscribedAgents.clear();
    
    if (this.connection) {
      try {
        await this.connection.stop();
        console.log('[SignalR] Disconnected');
      } catch (error) {
        console.error('[SignalR] Error during disconnect:', error);
      } finally {
        this.connection = null;
        this.setState('disconnected');
      }
    }
  }

  /**
   * Subscribe to notifications for specific agents
   */
  async subscribeToAgents(agentNames: string[]): Promise<void> {
    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) {
      throw new Error('Not connected to hub');
    }

    if (agentNames.length === 0) return;

    try {
      const result = await this.connection.invoke('SubscribeToAgents', agentNames);
      console.log('[SignalR] Subscribe result:', result);

      // Track subscribed agents
      if (result.subscribed) {
        result.subscribed.forEach((agent: string) => this.subscribedAgents.add(agent));
      }

      this.options.onSubscribed?.(result.subscribed || [], result.denied || []);

      if (result.denied?.length > 0) {
        console.warn('[SignalR] Access denied to agents:', result.denied);
      }

    } catch (error) {
      console.error('[SignalR] Subscribe failed:', error);
      throw error;
    }
  }

  /**
   * Unsubscribe from agent notifications
   */
  async unsubscribeFromAgents(agentNames: string[]): Promise<void> {
    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) {
      return;
    }

    try {
      await this.connection.invoke('UnsubscribeFromAgents', agentNames);
      
      // Remove from tracking
      agentNames.forEach(agent => this.subscribedAgents.delete(agent));
      
      console.log('[SignalR] Unsubscribed from:', agentNames);
    } catch (error) {
      console.error('[SignalR] Unsubscribe failed:', error);
    }
  }

  /**
   * Get current subscription status from server
   */
  async getSubscriptions(): Promise<void> {
    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) {
      return;
    }

    try {
      await this.connection.invoke('GetSubscriptions');
    } catch (error) {
      console.error('[SignalR] GetSubscriptions failed:', error);
    }
  }

  /**
   * Re-subscribe to all tracked agents (useful after reconnect)
   */
  private async resubscribeAll(): Promise<void> {
    if (this.subscribedAgents.size === 0) return;
    
    const agents = Array.from(this.subscribedAgents);
    console.log('[SignalR] Re-subscribing to agents:', agents);
    
    try {
      await this.subscribeToAgents(agents);
    } catch (error) {
      console.error('[SignalR] Re-subscription failed:', error);
    }
  }

  /**
   * Setup SignalR event handlers
   */
  private setupEventHandlers(): void {
    if (!this.connection) return;

    // Connection events
    this.connection.on('Connected', (data) => {
      console.log('[SignalR] Server confirmed connection:', data);
    });

    this.connection.on('Subscribed', (data) => {
      console.log('[SignalR] Subscribed:', data);
      this.options.onSubscribed?.(data.subscribed || [], data.denied || []);
    });

    this.connection.on('Unsubscribed', (data) => {
      console.log('[SignalR] Unsubscribed:', data);
    });

    this.connection.on('SubscriptionStatus', (data) => {
      console.log('[SignalR] Subscription status:', data);
    });

    // Notification event - THE MAIN EVENT
    this.connection.on('ReceiveNotification', (notification: MailPushNotification) => {
      console.log('[SignalR] 📬 Notification received:', notification.event_type, notification.data.from_agent);
      this.options.onNotification?.(notification);
    });

    this.connection.on('Error', (error) => {
      console.error('[SignalR] Server error:', error);
      this.options.onError?.(new Error(error.message || 'Unknown server error'));
    });

    // Connection lifecycle events
    this.connection.onreconnecting((error) => {
      console.log('[SignalR] Reconnecting...', error?.message);
      this.setState('reconnecting');
      this.reconnectAttempts++;
    });

    this.connection.onreconnected(async (connectionId) => {
      console.log('[SignalR] Reconnected:', connectionId);
      this.setState('connected');
      this.reconnectAttempts = 0;
      
      // Re-subscribe to agents after reconnect
      await this.resubscribeAll();
    });

    this.connection.onclose(async (error) => {
      console.log('[SignalR] Connection closed:', error?.message);
      this.setState('disconnected');

      // Check if it was an auth error (401)
      const isAuthError = error?.message?.includes('401') || 
                          error?.message?.includes('Unauthorized') ||
                          error?.message?.includes('authentication');

      if (isAuthError) {
        console.log('[SignalR] Auth error detected, attempting token refresh and reconnect...');
        // P1: Save subscriptions BEFORE any reconnect attempt — they must survive failures
        const savedAgents = new Set(this.subscribedAgents);
        try {
          // Force token refresh via the main process
          const freshToken = await this.options.getAccessToken();
          if (freshToken) {
            console.log('[SignalR] Got fresh token, reconnecting...');
            await new Promise(r => setTimeout(r, 1000));
            await this.connect();
            // Restore and re-subscribe
            this.subscribedAgents = savedAgents;
            if (this.subscribedAgents.size > 0) {
              await this.resubscribeAll();
            }
            return;
          }
        } catch (reconnectError) {
          console.error('[SignalR] Failed to reconnect after auth error:', reconnectError);
          // Preserve subscriptions so next reconnect attempt can restore them
          this.subscribedAgents = savedAgents;
          return;
        }
      }

      this.subscribedAgents.clear();
    });
  }

  /**
   * Update state and notify listener
   */
  private setState(state: ConnectionState): void {
    if (this.currentState !== state) {
      this.currentState = state;
      this.options.onStateChange?.(state);
    }
  }
}

/** Singleton instance */
let clientInstance: AgentMailSignalRClient | null = null;

/**
 * Get or create SignalR client instance
 */
export function getSignalRClient(options?: SignalRClientOptions): AgentMailSignalRClient {
  if (!clientInstance && options) {
    clientInstance = new AgentMailSignalRClient(options);
  }
  if (!clientInstance) {
    throw new Error('SignalR client not initialized');
  }
  return clientInstance;
}

/**
 * Reset client instance (for testing or re-auth)
 */
export function resetSignalRClient(): void {
  clientInstance?.disconnect().catch(console.error);
  clientInstance = null;
}