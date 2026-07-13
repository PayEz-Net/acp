# WO: Wire PayEzVibe agent session lifecycle into ACP desktop spawn flow

> **From:** DotNetPert  
> **To:** NextPert  
> **CC:** BAPert, QAPert  
> **Status:** Implemented — doc alignment in progress; pending QAPert sign-off  
> **Related:** [`PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/docs/PAYEZVIBE_AGENT_OUTPUT_API_SPEC.md`](../../PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/docs/PAYEZVIBE_AGENT_OUTPUT_API_SPEC.md)

---

## 1. Background

DotNetPert completed the **Agent Terminal Output JWT capability refactor** (WO from QAPert). The backend now emits `agent_terminal_output` in the user JWT `capabilities` claim for users with `vibe_agents_user`, `vibe_agent_system_user`, or `vibe_app_admin` roles.

In production, `GET /v1/agent-output/stream` now returns **400** instead of 403. Auth is passing; the 400 is because `AgentOutputController` cannot find an active PayEzVibe agent session for the caller.

### Evidence from Azure Graylog (last hour)

```text
VIBE_REQUEST: "GET" "/v1/agent-output/stream" - Status: 400 - IDPClientId: 9 - User: "22"
AGENT_OUTPUT_SESSION_RESOLVE: no active session for user 22 agent "BAPert"
```

There are **no `SESSION_STARTED` logs** in the same window, so the desktop spawn flow never creates PayEzVibe `agent_sessions` records.

## 2. Goal

Integrate the existing PayEzVibe `AgentSessionController` endpoints into the ACP desktop spawn/teardown lifecycle so that every spawned agent has an active session while it is running.

## 3. Required changes

### 3.1 Start a session on successful spawn

After `spawnAgent` succeeds in `acp-desktop/src/main/spawn-orchestrator.ts` (or the equivalent spawn completion path in `src/main/pty.ts`):

1. Get the agent's numeric `agent_id` from the project team context already fetched by the orchestrator (`ProjectTeamMember.agent_id`).
2. Build an authenticated request to the PayEzVibe API:
   - **URL:** `POST {VIBE_API_URL}/v1/sessions/start`
   - **Headers:** `Authorization: Bearer <user-access-token>` (reuse `getAccessToken()` / `buildVsqlCacheAuthHeaders`)
   - **Body:** `{ "agent_id": <agent_id>, "project_id": <project_id> }`
     - `project_id` is the user's active project; it is stored on the session so stream validation matches the `projectId` query parameter.
3. Store the returned session object (`session.id`, `session.session_token`, `session.agent_id`) alongside the `ManagedPty` / `SpawnedAgentRecord` so it can be referenced on heartbeat and teardown.

### 3.2 Heartbeat while alive

Keep the session active by calling `POST {VIBE_API_URL}/v1/sessions/{id}/heartbeat` approximately every **25–30 seconds** while the PTY is running. You can attach this to an existing timer loop or create a lightweight per-terminal interval that is cleared on exit.

### 3.3 End the session on teardown

On PTY exit, kill, or project lifecycle teardown:

- Call `POST {VIBE_API_URL}/v1/sessions/{id}/end?reason=normal` for a natural process exit.
- Call `POST {VIBE_API_URL}/v1/sessions/{id}/end?reason=killed` when the user/agent kills the terminal.
- Call `POST {VIBE_API_URL}/v1/sessions/{id}/end?reason=teardown` when the project lifecycle tears the terminal down.
- Clear the heartbeat timer.

### 3.4 Capability gate

The desktop must check the user's JWT `capabilities` claim for `agent_terminal_output` before attempting any session lifecycle call. If the capability is missing, skip `start`, `heartbeat`, and `end` entirely.

`AgentSessionController` is also gated server-side on `agent_terminal_output`, so a disabled capability results in `403 FORBIDDEN`.

### 3.5 Error handling

- A failed session start must be **non-fatal** to the spawn itself; log a warning and continue. The agent can still run even if terminal output streaming degrades.
- On `401`/`403` from the session endpoints, stop retrying; the user token may be stale or the capability is missing.
- On transient `5xx`, retry with backoff, but do not block PTY operation.

## 4. Acceptance criteria

- [ ] After spawning agents, `GET /v1/agent-output/stream` returns `200` and streams SSE events instead of `400`.
- [ ] Graylog shows `SESSION_STARTED` for each spawned agent and no more `AGENT_OUTPUT_SESSION_RESOLVE: no active session` errors.
- [ ] Heartbeat requests keep `agent_sessions.is_active = true` while the PTY is alive.
- [ ] Kill/exit calls the session `end` endpoint.
- [x] Existing spawn/teardown behavior is unchanged when agent terminal output is disabled (no session API calls are attempted and no new errors appear).

## 5. Test plan

1. Run the ACP desktop against the Azure tenant (`api.idealvibe.online`) with project `25`.
2. Confirm the bearer token includes `agent_terminal_output` (already verified).
3. Spawn the project team.
4. Open the agent-overview / terminal stream UI.
5. Verify the stream connects (200) and receives `agent-output` SSE events.
6. Verify in Graylog:
   - `SESSION_STARTED` for each agent.
   - `AGENT_OUTPUT_SESSION_RESOLVE` resolves successfully.
   - `VIBE_REQUEST: GET /v1/agent-output/stream - Status: 200`.
7. Kill an agent and verify `SESSION_ENDED` is logged.
8. **Regression check with terminal output disabled:** disable the `agent_terminal_output` capability (or the equivalent feature flag), spawn and teardown an agent, and verify that no session-start/heartbeat/end requests are made and that spawn/teardown behavior is unchanged.

## 6. References

- `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Controllers/V1/AgentSessionController.cs`
- `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Controllers/V1/AgentOutputController.cs`
- `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/Services/AgentOutput/AgentSessionResolver.cs`
- `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/docs/PAYEZVIBE_AGENT_OUTPUT_API_SPEC.md`
- `acp-desktop/src/main/spawn-orchestrator.ts`
- `acp-desktop/src/main/pty.ts`
- `acp-desktop/src/main/vsql-cache-client.ts`
