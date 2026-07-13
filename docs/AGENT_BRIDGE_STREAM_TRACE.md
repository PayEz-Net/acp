# Agent Bridge Stream — End-to-End Trace

> Traced from the TypeScript front-end (`acp-desktop`, `acp-api`) through the .NET API (`PayEz.Vibe.Public.Api`) to the persistence layer (VibeSQL documents, vsql-cache PostgreSQL, local SQLite).
> This doc focuses on the three live streams the desktop uses: **mail SSE**, **lifecycle SignalR**, and **terminal-output SSE**.

---

## 1. High-level architecture

```mermaid
flowchart LR
    subgraph Desktop["acp-desktop (Electron)"]
        R[Renderer React]
        M[Main Node process]
    end

    subgraph Sidecar["acp-api (Node sidecar, 127.0.0.1:3001)"]
        SSE[/v1/sse/stream]
        UP[UpstreamSseManager]
        LEB[LocalEventBus]
        TOB[TerminalOutputBridge]
        AOS[(AgentOutputStore SQLite)]
    end

    subgraph Cloud["PayEz.Vibe.Public.Api (AKS / api.idealvibe.online)"]
        AM[/v1/agentmail/stream]
        AH[/hubs/agentmail SignalR]
        AO[/v1/agent-output]
        VC[VsqlCacheClient]
    end

    subgraph Cache["vsql-cache service"]
        VCS[vsql-cache pod]
        PG[(vsql_cache Postgres)]
    end

    subgraph Data["VibeSQL Server"]
        VSQL[(vibe.documents etc.)]
    end

    R -->|SSE| SSE
    SSE --> UP
    UP -->|SSE| AM
    AM -->|new-mail event| UP
    UP -->|mail event| SSE
    SSE -->|agent-output etc.| R

    M -->|SignalR| AH
    AH -->|project-lifecycle-changed etc.| M

    M -->|POST /v1/agent-output| AO
    AO --> VC
    VC -->|POST /v1/agent-output| VCS
    VCS --> PG
    R -->|SSE /v1/agent-output/stream| AO
    AO -->|proxies SSE| VCS
    VCS -->|agent-output SSE| R

    AM -->|SendMailAsync / GetInboxAsync| VSQL
```

---

## 2. Path 1 — Live Mail SSE Stream

This is the stream that was silent in Azure. It carries new-mail pushes, party/autonomy/kanban/contractor events, and heartbeats.

### 2.1 Renderer opens the downstream SSE

**File:** `acp-desktop/src/renderer/hooks/useAcpSse.ts`

- Mounted once at `App` level (not per pane).
- `useEffect` fires when `backendAvailable` or the agent roster (`agentNamesKey`) changes.
- Connects to:
  ```
  http://127.0.0.1:3001/v1/sse/stream?agents=DotNetPert,BAPert,...&project_id=...
  ```
- Sends `Authorization: Bearer <local-secret>` and `X-Idp-Client-App: acp-desktop`.
- Parses SSE frames; handles:
  - `event: ping` → updates `lastPingRef`, used by the 60s stale-ping watchdog.
  - `event: mail` → adds a visual notice to the agent's transcript/terminal and calls `useMailStore.fetchInbox(agent, projectId)`.
  - `event: party-update`, `autonomy-update`, `kanban-update`, `chat-message`, contractor events, `standup_report`, etc. → dispatched to the corresponding Zustand stores.
- On reconnect (`hasConnectedRef.current === true`), calls `useMailStore.fetchAllInboxes(...)` to catch up.
- **Failure behavior:** no hard retry limit; exponential backoff to 30s. A stale ping (>60s) forces an abort and reconnect.

### 2.2 acp-api fans out downstream events

**File:** `acp-api/api/routes/sseStream.ts`

- Express router mounted at `/v1/sse`.
- Maintains a `Set` of connected renderer clients with their `agents` filter and `projectId`.
- Two input sources:
  1. `upstreamManager.onMailEvent(...)` — cloud mail pushes.
  2. `localEventBus.onEvent(...)` — local events (party/autonomy/standup/contractor/`agent-output`).
- For `agent-output` events it filters by subscribed agent **and** by matching `project_id`, then strips `project_id` before writing to the wire.
- Sends an initial `event: connected`, then replays recent agent-output lines from `AgentOutputStore` if `project_id` and `since` are provided, then starts a 30s heartbeat `event: ping`.
- `recomputeUpstream()` — when the renderer's agent list changes, refreshes the upstream SSE subscriptions so only requested agents are subscribed.

### 2.3 acp-api opens upstream SSE to the cloud

**File:** `acp-api/api/sse/upstreamManager.ts`

- `UpstreamSseManager` starts one upstream SSE connection **per agent**.
- Connects to:
  ```
  ${VIBE_API_URL}/v1/agentmail/stream?agent={agent}
  ```
- Auth: IDP bearer token plus `X-Client-Id` from the token's own `client_id` claim and `X-Vibe-Via: idp-proxy`.
- Parses SSE frames; only acts on `event: new-mail` / `mail` and `connected`.
- Emits to downstream via `onMailEvent` handlers.
- Reconnect behavior:
  - `403`/`404` → terminal failure for that agent (not retried).
  - Other HTTP errors / network errors → exponential backoff, 2s–60s.
  - After 5 consecutive failures → enters **degraded** state, retries every 15s.
  - `NO_SESSION` → retries every 5s until login.

### 2.4 Cloud serves the upstream SSE stream

**File:** `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Controllers/V1/AgentMailController.cs` (method `StreamMailNotifications`, `[HttpGet("stream")]`)

- Validates `agent` query param.
- Gets effective user ID from `VibeClientContext` (JWT/impersonation/admin).
- Verifies the caller owns the requested agent via `_agentMailService.ListAgentsAsync(...)`.
- Sets SSE headers (`text/event-stream`, `Connection: keep-alive`, `X-Accel-Buffering: no`).
- Logs `SSE_STREAM_CONNECTED`.
- Subscribes to the in-memory pub/sub:
  ```csharp
  using var subscription = AgentMailNotificationService.Subscribe(agent, async (notification) => { ... });
  ```
- Sends `event: connected` immediately, then loops writing 30s `: heartbeat` comments until the request is aborted.
- On a notification, writes:
  ```
  event: new-mail\ndata: { ...MailNotification... }\n\n
  ```
- Logs `SSE_EVENT_SENT` per event and `SSE_STREAM_CLOSED`/`SSE_STREAM_ERROR` on teardown.

### 2.5 Where do the notifications come from?

There are two notification paths in the .NET API:

#### A. In-process SSE pub/sub (used by `/v1/agentmail/stream`)

**File:** `PayEz-Core/PayEz.Services/PayEz.Vibe.Application/Services/AgentMail/AgentMailNotificationService.cs`

- Static in-memory `ConcurrentDictionary<string, ConcurrentBag<...>>` keyed by lower-cased agent name.
- `Subscribe(agent, handler)` registers a callback.
- `NotifyAsync(agent, notification)` calls all handlers.
- Called by `AgentMailService.SendMailAsync(...)` for every recipient name after the DB rows are written.

#### B. SignalR + Redis backplane (used by `/hubs/agentmail`)

**File:** `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Services/AgentMailNotificationService.cs`

- Implements `IAgentMailNotificationService`.
- Injected with `IHubContext<AgentMailHub>`.
- `NotifyAgentAsync(clientId, agentId, notification)` sends to SignalR group `agent_{clientId}_{agentId}`.
- `NotifyUserAsync(...)` sends to group `user_{clientId}_{userId}`.
- Also exposes connection stats via statics on `AgentMailHub`.

The **mail SSE stream does not use SignalR**; it uses the static in-memory pub/sub. The SignalR hub is a separate surface used by `lifecycle-hub.ts` and any other SignalR clients.

### 2.6 Sending mail — the write path

**File:** `PayEz-Core/PayEz.Services/PayEz.Vibe.Application/Services/AgentMail/AgentMailService.cs` (`SendMailAsync`)

1. Validates request (size, recipients, rate limits).
2. Resolves sender/recipient agents via `IAgentRepository` (reads `vibe.documents` collection `vibe_agents` / table `agent_profiles`).
3. Resolves `projectId` (from request or first project).
4. Creates the message row via `IAgentMailRepository.CreateMessageAsync(...)`.
5. Creates inbox entries for every recipient via `IAgentMailInboxRepository.CreateInboxEntryAsync(...)`.
6. Notifies:
   - In-process SSE: `AgentMailNotificationService.NotifyAsync(recipientName, sseNotification)`.
   - SignalR: `_signalRNotificationService.NotifyAgentAsync(...)` for each distinct recipient agent ID.
7. Emits Wave-E state-hub events (agent-status, project-activity-event) if those services are wired.
8. Runs registered `IMailPersistedHandler` handlers (e.g. standup mail harvest).

### 2.7 Persistence — messages and inbox

**Files:**
- `PayEz-Core/PayEz.Services/PayEz.Infrastructure/Repositories/Vibe/AgentMailVibeSqlMessageRepository.cs`
- `PayEz-Core/PayEz.Services/PayEz.Infrastructure/Repositories/Vibe/AgentMailVibeSqlInboxRepository.cs`

Both are registered in `Program.cs`:
```csharp
services.AddScoped<IAgentMailRepository, AgentMailVibeSqlMessageRepository>();
services.AddScoped<IAgentMailInboxRepository, AgentMailVibeSqlInboxRepository>();
```

They talk to VibeSQL Server via `IVibeSqlServerClient` and operate on `vibe.documents`:

| Collection | Table | What it stores |
|------------|-------|----------------|
| `agent_mail` | `agent_mail_messages` | The message: `id`, `project_id`, `from_agent_id`, `from_user_id`, `thread_id`, `subject`, `body`, `body_format`, `importance`, `created_at`. |
| `agent_mail` | `agent_mail_inbox` | One row per recipient: `id`, `message_id`, `agent_id`, `recipient_type`, optional `read_at`. |

IDs come from per-client Postgres sequences (`vibe.seq_{clientId}_agent_mail_messages` / `..._inbox`).

**Entity:** `PayEz.Domain.Entities.Vibe.VibeDocument`
- `DocumentId`, `ClientId`, `OwnerUserId`, `Collection`, `TableName`, `Data` (JSONB string), `CollectionSchemaId`, audit timestamps.

**Relational schema (for vibesql-mail standalone):** `PayEz-Core/vibe/VibeSQL-Server/src/VibeSQL.Core/Data/Migrations/20260314_AgentMailSchema_Relational.sql`
- `messages` table (`id`, `from_agent_id`, `thread_id`, `subject`, `body`, ...)
- `inbox` table (`id`, `message_id`, `agent_id`, `recipient_type`, `read_at`, `archived_at`)
- Indexes on `inbox(agent_id)`, `inbox(message_id)`, `inbox(agent_id) WHERE read_at IS NULL`, `messages(thread_id)`, etc.

### 2.8 Reading mail — the catch-up path

**File:** `PayEz-Core/PayEz.Services/PayEz.Vibe.Application/Services/AgentMail/AgentMailService.cs` (`GetInboxAsync`)

- Verifies agent access.
- Calls `IAgentMailInboxRepository.GetInboxPageAsync(...)` — a single SQL join of inbox + messages.
- Service layer resolves `from_agent_id` → name/display-name via `IAgentRepository.GetAllAgentsIncludingInactiveAsync(...)` so historical senders still render.
- Returns `AgentMailInboxResult` → `AgentMailController` → `acp-api` mail proxy → `mailStore.fetchInbox` / `fetchAllInboxes`.

---

## 3. Path 2 — SignalR Lifecycle / State Hub

This is the second live channel. It pushes project lifecycle, kanban counts, agent status, and project activity events.

### 3.1 acp-desktop main connects directly

**File:** `acp-desktop/src/main/lifecycle-hub.ts`

- Builds a `@microsoft/signalr` connection to `HUB_URL` = `https://api.idealvibe.online/hubs/agentmail`.
- Auth: fresh IDP access token via `accessTokenFactory`.
- Transports: WebSockets | ServerSentEvents | LongPolling.
- Handles server events:
  - `agent-status-changed`
  - `project-lifecycle-changed`
  - `project-activity-event`
  - `project-kanban-active-count-changed`
- Emits those to the spawn orchestrator / party engine via Node `EventEmitter`.
- Includes a fallback `seedInitialLifecycleState()` that polls the local acp-api if the snapshot-on-connect is silent.

### 3.2 Cloud SignalR hub

**File:** `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Hubs/AgentMailHub.cs`

- `[Authorize(JwtBearerDefaults.AuthenticationScheme)]`.
- `OnConnectedAsync`:
  - Extracts `user_id` and `client_id` claims.
  - Adds connection to user group `user_{clientId}_{userId}`.
  - If state-hub dependencies are wired, enumerates the user's projects and all canonical agents, joins project/agent groups, and sends snapshot events.
  - Logs `AGENTMAIL_HUB_CONNECTED`.
- `SubscribeToAgents(agentNames)` — joins per-agent groups `agent_{clientId}_{agentId}`.
- `OnDisconnectedAsync` — cleans up groups and logs `AGENTMAIL_HUB_DISCONNECTED`.

### 3.3 Redis backplane

**File:** `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Extensions/SignalRExtensions.cs`

```csharp
services.AddSignalR(options => {
    options.KeepAliveInterval = TimeSpan.FromSeconds(15);
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
});

var redis = configuration.GetConnectionString("Redis");
if (!string.IsNullOrEmpty(redis)) {
    signalRBuilder.AddStackExchangeRedis(redis, options => {
        options.Configuration.ChannelPrefix = RedisChannel.Literal("VibeAgentMail");
    });
}
```

- In dev, `appsettings.Development.json` has no Redis connection string → backplane is not used (single process).
- In prod AKS, the ConfigMap sets:
  ```json
  "ConnectionStrings": { "Redis": "redis.internal.svc.cluster.local:6379" }
  ```
- If Redis is unreachable, SignalR cannot fan out across pods; connections may appear healthy but no cross-pod events flow.

---

## 4. Path 3 — Terminal Output Stream (vsql-cache)

This is the unified agent-overview terminal stream. It is separate from the mail SSE.

### 4.1 acp-desktop reports raw PTY output

**Files:**
- `acp-desktop/src/main/ptyOutputReporter.ts`
- `acp-desktop/src/main/vsql-cache-client.ts`

- `reportPtyOutput(agentName, terminalId, data, provider, projectId, sessionId)` batches per-terminal chunks.
- Flushes every 150ms or 8KB.
- `postAgentOutput` POSTs to:
  ```
  ${VIBE_API_URL}/v1/agent-output
  ```
- Uses IDP bearer auth and `X-Vibe-User-Id` / `X-Vibe-Project-Id` headers.
- 503 is swallowed (drop count logged); any other error throws.

### 4.2 Cloud proxies to vsql-cache

**File:** `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Controllers/V1/AgentOutputController.cs`

- `POST /v1/agent-output`:
  - Validates user context.
  - Normalizes provider to `claude`/`kimi`/`codex`.
  - Resolves the agent's active session via `IAgentSessionResolver`.
  - Builds `VsqlCacheAuthContext` and `VsqlCacheOutputPayload`.
  - Calls `_vsqlCacheClient.PostAgentOutputAsync(...)`.
- `GET /v1/agent-output/stream`:
  - Validates `projectId` and `agents`.
  - Resolves session, matches project.
  - Sets SSE headers and proxies `_vsqlCacheClient.StreamAgentOutputAsync(...)` line-by-line to the renderer.

**File:** `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Services/AgentOutput/VsqlCacheClient.cs`

- `HttpClient` with base address = `VsqlCache:BaseUrl` (from config, e.g. `http://vsql-cache.internal.svc.cluster.local`).
- Auth: `Authorization: Secret {ContainerSecret}` plus context headers.
- `PostAgentOutputAsync` → `POST v1/agent-output`.
- `StreamAgentOutputAsync` → `GET v1/agent-output/stream?projectId=...&agents=...&since=...`.

### 4.3 vsql-cache service persists and re-streams

**Image:** `payezcontainers.azurecr.io/vsql-cache:vibe-94-aks`
**Config:** `PayEz-Core/AKS/configmaps/vsql-cache-config.yaml`
**DB migration:** `PayEz-Core/AKS/migrations/vsql-cache/001_create_vsql_cache_database.sql`

- Receives raw PTY chunks, normalizes/strips ANSI, scrubs secrets, and stores in:
  ```sql
  CREATE TABLE vibe_cache.agent_output_events (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'anonymous',
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      terminal_id TEXT NOT NULL,
      provider TEXT,
      line TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ```
- Indexes: `idx_agent_output_user_ts`, `idx_agent_output_project_ts`, `idx_agent_output_project_agent`.
- Serves `GET /v1/agent-output/stream` as SSE with `event: agent-output` lines.

### 4.4 Renderer consumes terminal output

**File:** `acp-desktop/src/renderer/hooks/useVsqlCacheSse.ts`

- Connects to `vsqlCacheBaseUrl/v1/agent-output/stream?projectId=...&agents=...&since=...`.
- `vsqlCacheBaseUrl` is returned by the main process; in current builds it equals `VIBE_API_URL` because the renderer is not given the internal cache URL directly.
- Batches incoming `agent-output` lines 50ms at a time and writes them to `useAgentOutputStore`.
- Reconnects with exponential backoff.

---

## 5. Local sidecar storage for terminal output

**Files:**
- `acp-api/api/terminal/terminalOutputBridge.ts`
- `acp-api/api/terminal/agentOutputStore.ts`

When acp-desktop reports PTY output to the **local sidecar** (`/internal/pty/output`), not to the cloud:

1. `TerminalOutputBridge.push(...)` strips ANSI, collapses line endings, scrubs secrets, throttles per-agent (burst 25, refill 10/sec).
2. Emits `agent-output` events on `LocalEventBus`.
3. Writes normalized lines to `AgentOutputStore` SQLite (`data/agent-output.sqlite`).

Schema (`agent_output_lines`):
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
project_id TEXT NOT NULL,
session_id TEXT NOT NULL,
agent TEXT NOT NULL,
terminal_id TEXT NOT NULL,
provider TEXT,
line TEXT NOT NULL,
ts TEXT NOT NULL,
created_at TEXT NOT NULL
```

- Free tier retention: 10,000 events or 7 days.
- Pro: 50,000 / 30 days.
- Enterprise: unlimited.

This store is used by `sseStream.ts` to replay recent output to reconnecting renderer clients before attaching to live events.

---

## 6. Component map

| Component | Repo / Path | Responsibility |
|-----------|-------------|----------------|
| `useAcpSse` | `acp-desktop/src/renderer/hooks/useAcpSse.ts` | Renderer-side downstream SSE consumer for mail + local events. |
| `useVsqlCacheSse` | `acp-desktop/src/renderer/hooks/useVsqlCacheSse.ts` | Renderer-side terminal-output SSE consumer. |
| `mailStore` | `acp-desktop/src/renderer/stores/mailStore.ts` | Fetches inboxes; catch-up on reconnect. |
| `lifecycle-hub.ts` | `acp-desktop/src/main/lifecycle-hub.ts` | Main-process SignalR client for lifecycle/state. |
| `ptyOutputReporter` | `acp-desktop/src/main/ptyOutputReporter.ts` | Batches raw PTY output and POSTs to cloud. |
| `sseStream.ts` | `acp-api/api/routes/sseStream.ts` | Downstream SSE endpoint; fans out mail + local events; catch-up from store. |
| `upstreamManager.ts` | `acp-api/api/sse/upstreamManager.ts` | Upstream SSE connections to `vibe-api/v1/agentmail/stream`. |
| `localEventBus.ts` | `acp-api/api/sse/localEventBus.ts` | In-process pub/sub for party/autonomy/standup/contractor/agent-output. |
| `terminalOutputBridge.ts` | `acp-api/api/terminal/terminalOutputBridge.ts` | Normalizes/scrubs/throttles local PTY output. |
| `agentOutputStore.ts` | `acp-api/api/terminal/agentOutputStore.ts` | SQLite retention store for local terminal output. |
| `AgentMailController` | `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Controllers/V1/AgentMailController.cs` | REST + SSE endpoints for agent mail. |
| `AgentMailHub` | `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Hubs/AgentMailHub.cs` | SignalR hub for lifecycle/state/mail. |
| `AgentMailNotificationService` (API) | `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Services/AgentMailNotificationService.cs` | SignalR group notifications. |
| `AgentMailNotificationService` (App) | `PayEz-Core/PayEz.Services/PayEz.Vibe.Application/Services/AgentMail/AgentMailNotificationService.cs` | In-memory SSE pub/sub. |
| `AgentMailService` | `PayEz-Core/PayEz.Services/PayEz.Vibe.Application/Services/AgentMail/AgentMailService.cs` | Business logic for send/inbox/read. |
| `AgentMailVibeSqlMessageRepository` | `PayEz-Core/PayEz.Services/PayEz.Infrastructure/Repositories/Vibe/` | VibeSQL message CRUD. |
| `AgentMailVibeSqlInboxRepository` | `PayEz-Core/PayEz.Services/PayEz.Infrastructure/Repositories/Vibe/` | VibeSQL inbox CRUD. |
| `VibeDocument` | `PayEz-Core/PayEz.Domain/Entities/Vibe/VibeDocument.cs` | Document entity returned by repos. |
| `AgentOutputController` | `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Controllers/V1/AgentOutputController.cs` | Receives terminal output, proxies to vsql-cache, serves SSE. |
| `VsqlCacheClient` | `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Services/AgentOutput/VsqlCacheClient.cs` | Internal HTTP+SSE client to vsql-cache. |
| `SignalRExtensions` | `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Extensions/SignalRExtensions.cs` | SignalR + Redis backplane + JWT auth registration. |

---

## 7. Why the Azure stream was silent (from Graylog evidence)

From the Graylog trace in the companion investigation:

- `/v1/agentmail/stream` had **zero hits** in the last 20 minutes.
- `/hubs/agentmail` had **zero hits** in the last 20 minutes.
- Only REST `/v1/agentmail/inbox/*` calls were present.
- SSE streams that existed earlier in the day all closed at 16:30 and never reconnected after a pod replacement.
- SignalR connections were intermittent; the last successful connect was ~30 minutes before the check, then silence.

**Interpretation:** the live streams were dead. The renderer stayed alive only because `useAcpSse` fell back to reconnect + `fetchAllInboxes` catch-up, which created the `Maximum update depth exceeded` warning in `acpSessionStore` / `mailStore`.

Likely root causes to verify:
1. **Local sidecar not reconnecting** after `vibe-api` pod replacement — check `acp-api` logs for `[SSE] {agent}: error` / `degraded`.
2. **Azure ingress/Istio dropping long-lived connections** — nginx ingress for `api.idealvibe.online` has no WebSocket/SSE timeout annotations; SignalR may fail the WebSocket upgrade and fall back silently, or SSE may be buffered/closed by the proxy.
3. **Redis backplane misconfiguration** — `ConnectionStrings:Redis` points to `redis.internal.svc.cluster.local:6379`, which may not exist in Azure; without it, cross-pod SignalR fan-out fails.

---

## 8. Useful queries and checks

### Verify vsql-cache activity (prod)
```sql
SELECT
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS rows_last_1h,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '5 minutes') AS rows_last_5m,
  MAX(created_at) AS latest_row,
  COUNT(DISTINCT agent_name) AS distinct_agents
FROM vibe_cache.agent_output_events;
```

### Verify agent mail persistence (via VibeSQL)
```sql
-- Messages last hour
SELECT COUNT(*) FROM vibe.documents
WHERE collection = 'agent_mail' AND table_name = 'agent_mail_messages'
  AND created_at > NOW() - INTERVAL '1 hour';

-- Inbox rows last hour
SELECT COUNT(*) FROM vibe.documents
WHERE collection = 'agent_mail' AND table_name = 'agent_mail_inbox'
  AND created_at > NOW() - INTERVAL '1 hour';
```

### Check local acp-api SSE state
```bash
curl -N http://127.0.0.1:3001/v1/sse/status
# returns per-agent upstream state + downstream client count
```

### Check local acp-api logs for upstream errors
```bash
# Look for:
[SSE] DotNetPert: error (3/5): ...
[SSE] DotNetPert: degraded after 5 failures
[LifecycleHub] initial connect failed: ...
```

---

*Generated by tracing the live code in `e:/repos/acp-desktop`, `e:/repos/acp-api`, and `e:/repos/PayEz-Core`.*
