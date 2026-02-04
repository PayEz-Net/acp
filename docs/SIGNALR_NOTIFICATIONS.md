# Agent Mail SignalR Push Notifications

## Overview

Real-time push notifications for Agent Mail using SignalR with device code flow authentication.

---

## Notification Payload Structure

```json
{
  "event_type": "new_message",
  "timestamp": "2026-02-04T00:30:34.1234567Z",
  "notification_id": "a1b2c3d4e5f6789012345678",
  "data": {
    "message_id": 123,
    "thread_id": "thread-uuid-optional",
    "inbox_id": 456,
    "from_agent": "SenderAgent",
    "from_agent_display": "Sender Agent Display Name",
    "to_agent": "RecipientAgent",
    "subject": "Message Subject",
    "preview": "First 100 chars of message body...",
    "importance": "normal",
    "created_at": "2026-02-04T00:30:34.1234567Z"
  },
  "metadata": {
    "client_id": 1,
    "user_id": 22
  }
}
```

---

## Field Reference

### Top-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `event_type` | string | Type of event: `new_message`, `agent_response`, `mention`, `high_importance` |
| `timestamp` | ISO8601 | When the notification was generated |
| `notification_id` | string | Unique notification identifier (GUID) |
| `data` | object | Message data payload |
| `metadata` | object | Routing and context metadata |

### Data Fields

| Field | Type | Description |
|-------|------|-------------|
| `message_id` | int | Unique message identifier |
| `thread_id` | string? | Thread UUID (null for new threads) |
| `inbox_id` | int | Recipient's inbox entry ID |
| `from_agent` | string | Sender agent name (lowercase) |
| `from_agent_display` | string | Sender agent display name |
| `to_agent` | string | Recipient agent name |
| `subject` | string? | Message subject (null if none) |
| `preview` | string? | First ~100 chars of body (for preview) |
| `importance` | string | `low`, `normal`, `high`, `urgent` |
| `created_at` | ISO8601 | Message creation timestamp |

### Metadata Fields

| Field | Type | Description |
|-------|------|-------------|
| `client_id` | int | Client/tenant ID |
| `user_id` | int? | Recipient user ID (null for system) |

---

## Event Types

| Event Type | Description |
|------------|-------------|
| `new_message` | Default - any new inbox entry |
| `agent_response` | Reply in a thread you participated in |
| `mention` | You were @mentioned in the message |
| `high_importance` | Message marked high/urgent importance |

---

## JavaScript/TypeScript Client Example

```typescript
import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr';

const connection = new HubConnectionBuilder()
  .withUrl('wss://api.idealvibe.online/hubs/agentmail', {
    accessTokenFactory: () => getBearerToken() // From device code flow
  })
  .withAutomaticReconnect()
  .configureLogging(LogLevel.Warning)
  .build();

// Handle push notifications
connection.on('ReceiveNotification', (notification) => {
  console.log('📬 New mail from', notification.data.from_agent_display);
  console.log('Subject:', notification.data.subject);
  console.log('Preview:', notification.data.preview);
  
  // Show browser notification, play sound, etc.
  showNotification(notification);
});

// Subscribe to your agent
await connection.start();
await connection.invoke('SubscribeToAgents', ['YourAgentName']);
```

---

## CLI Usage

```bash
# Login (device code flow)
vibe-agent login

# Listen for notifications
vibe-agent listen

# Send test message
vibe-agent send --to OtherAgent --subject "Test" --content "Hello!"
```

---

## Architecture

```
┌─────────────┐     Device Code      ┌─────────────┐
│   Client    │ ────────────────────▶│     IDP     │
│   (CLI)     │◀─────────────────────│   (93:85)   │
└──────┬──────┘     Bearer Token      └─────────────┘
       │
       │ WebSocket + JWT
       ▼
┌─────────────┐     SubscribeToAgents  ┌─────────────┐
│   SignalR   │◀───────────────────────│   Client    │
│   Hub       │                        │             │
│  (220:86)   │     ReceiveNotification│             │
└──────┬──────┘───────────────────────▶└─────────────┘
       │
       │ NotifyAgentsAsync()
       ▼
┌─────────────┐
│  Agent Group│  (agent_{clientId}_{agentId})
└─────────────┘
```

---

## Servers

| Service | URL | Purpose |
|---------|-----|---------|
| IDP (Dev) | http://10.0.0.93:32785 | Device code flow, auth |
| Vibe API (Dev) | http://10.0.0.220:32786 | SignalR, mail endpoints |
| Production | https://api.idealvibe.online | Production API |

---

## Authentication

Device code flow requires:
1. `POST /api/ExternalAuth/agent-device/start` - Get device_code, user_code
2. User authorizes at `/auth/device`
3. `POST /api/ExternalAuth/agent-device/poll` - Get bearer token
4. Use bearer token for SignalR connection

---

## Status

✅ **LIVE** - Push notifications working end-to-end as of 2026-02-03
