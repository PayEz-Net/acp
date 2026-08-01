# ACP Agent-Session Churn — Analysis & Theory

**Date:** 2026-07-31
**Author:** Mac-side investigation (Kimi)
**Status:** Needs cloud-side / network confirmation

---

## 1. Symptom

Every 30 seconds, each running ACP agent gets:

```
[AgentSession] heartbeat 404 for session=NNNNNN; re-registering a fresh session
[AgentSession] re-registered session=MMMMMM (was NNNNNN) agent=X
```

The response body is always:

```json
{"success":false,"error":{"code":"SESSION_INACTIVE","message":"Session is not active"}}
```

This is a **token-draining loop**: `StartSession` → `Heartbeat 404` → `StartSession` → `Heartbeat 404` …

---

## 2. What we ruled out

### 2.1 Not the cloud `document_id` vs `data.id` mismatch

Earlier theory: `StartSession` returned `data.id` but `Heartbeat`/`EndSession` looked up by `document_id`.

**Ruled out.** The Windows team deployed a cloud rebuild from `PayEz-Core master` (returns `document.DocumentId`, looks up by `document_id`). We verified manually:

```bash
curl -X POST http://127.0.0.1:3001/v1/agent-sessions/start -d '{"agent_id":1}'
# → {"data":{"session":{"id":135822,...}}}
curl -X POST http://127.0.0.1:3001/v1/agent-sessions/135822/heartbeat
# → 200 OK
```

So the id scheme is now consistent. The 404s are **not** “session not found”; they are **`SESSION_INACTIVE`**.

### 2.2 Not the desktop duplicate-start bug (fixed)

We fixed the desktop dedupe (`d217021`): multiple terminals/runtimes for the same `agent_id` now share one cloud session. Logs confirm **one `started session=…` per agent** per run.

### 2.3 Not a local second ACP instance

We killed **all** Node/Electron/ACP processes on this Mac and did a clean `npm run dev:prod`. `ps` confirmed only one instance. The churn continued identically.

---

## 3. Evidence for a second (remote) client

### 3.1 DB query shows takeover ping-pong

A prod query for `agent_id=5` (QAPert) showed sessions alternating `project_id=18` and `project_id=31`, each ending the previous with `end_reason='takeover'` every ~30 seconds:

```
document_id | session_id | agent_id | project_id | is_active | end_reason | last_heartbeat_at
136632      | 80354      | 5        | 18         | true      |            | 2026-07-31T15:53:58
136626      | 80351      | 5        | 31         | false     | takeover   | 2026-07-31T15:53:55
136612      | 80346      | 5        | 18         | false     | takeover   | 2026-07-31T15:53:27
136608      | 80344      | 5        | 31         | false     | takeover   | 2026-07-31T15:53:23
...
```

The same pattern appeared for agents 1, 2, 3, 162.

### 3.2 `end_reason=takeover` is only set by `StartSession`

In `AgentSessionController.StartSession`, the cloud ends any existing active session for the same `user_id + agent_id` and marks it `end_reason='takeover'`. Heartbeats do **not** end sessions. So every `takeover` row means someone called `StartSession`.

### 3.3 The same `agent_id` is used in both projects

Even though the projects differ (18 vs 31), the `agent_id` is identical (e.g. `5`). The cloud collides on **`user_id + agent_id`**, not on project or team. So two clients using the same underlying agent instance will keep killing each other regardless of project.

### 3.4 Timing matches the desktop heartbeat interval

Takeovers happen every ~30 seconds, exactly the desktop’s `HEARTBEAT_INTERVAL_MS`. That is the re-register loop: each client heartbeats, sees `SESSION_INACTIVE`, and re-registers, taking over the other.

---

## 4. Theory

**Two ACP clients are running the same `user_id` + `agent_id`s.** One is this Mac (`project_id=18`). The other is a remote client (`project_id=31`) — most likely the Windows rig, another developer machine, or a CI/server process — hitting the same prod cloud.

Because the cloud enforces one active session per `user_id + agent_id`, each client’s `StartSession` takes over the other’s session. Both then heartbeat-404 and re-register, creating the observed 30-second churn.

---

## 5. What to investigate (cloud/network side)

1. **Cloud logs for `StartSession`**: look for repeated calls for the same `agent_id` from two different sources (IP, user-agent, client_id, or machine name if logged). The `agent_sessions` table has `machine_name`; the current rows have `null`, but the API accepts it.
2. **IDP / access logs**: which bearer tokens are calling `/v1/sessions/start`? Are there two active sessions for the same user from different IPs/devices?
3. **Windows rig / other machines**: confirm whether any other ACP Desktop (or a script using the session API) is running with the same agents. Even if projects/teams differ, the `agent_id` collision is what matters.
4. **CI / automation**: any scheduled job or integration test calling `StartSession`?

---

## 6. Recommended fixes

| Option | Action | Trade-off |
|---|---|---|
| **A** | Stop the other client | Immediate, no code change |
| **B** | Use different `agent_id`s for the other client | Requires separate team/agent instances |
| **C** (chosen) | Cloud keys sessions by `user_id + agent_id + project_id` | Allows same agent in different projects; requires `StartSession` filter change |

**Chosen fix (C):** `AgentSessionController.StartSession` should include `project_id` in the "end existing active sessions" filter so sessions are scoped to `user_id + agent_id + project_id`. This prevents cross-project takeovers while still preventing duplicates within a project.

---

## 7. Desktop-side changes already made

These are **not** the root cause, but they are correct and should stay:

- `d217021` — dedupe cloud sessions by `agent_id` (prevents self-inflicted takeovers from multiple terminals).
- `b94618c` — spawn gate: orchestrator ignores background `RUNNING` pushes until the user explicitly clicks **Start** in the project picker.

---

## 8. Bottom line

The churn is **not** a cloud id bug, **not** a desktop duplicate-start bug, and **not** a local second instance. The evidence points to a **remote second client** calling `StartSession` for the same `user_id + agent_id`s. Cloud-side logging should confirm the source in minutes.
