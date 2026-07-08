# Work Order Complete: acp-desktop → vsql-cache agent-output wiring

## Summary

Wired acp-desktop to the new vsql-cache backend for agent terminal output streaming.

## Backend endpoint

`http://10.0.0.93:52424` (default in code; override with `VSQL_CACHE_URL` env var).

## Reporter changes

File: `src/main/vsql-cache-client.ts`

- Stopped posting to any acp-api `agent-output` route.
- Now POSTs raw PTY chunks to `POST /v1/agent-output`.
- Auth header: `Authorization: Secret <VIBESQL_CONTAINER_SECRET>`.
- Sends scope headers: `X-Vibe-Project-Id`, `X-Vibe-User-Id`.
- Request body is exactly the work-order contract:
  ```json
  {
    "agentName": "<agent name>",
    "terminalId": "<terminal id>",
    "data": "<raw PTY chunk>",
    "provider": "claude | kimi | codex | ..."
  }
  ```
- 503 Service Unavailable is swallowed (logged as a drop by `ptyOutputReporter.ts`) — desktop does not crash.

File: `src/main/auth.ts`

- Added cached `getCurrentUserId()` helper so the reporter can resolve the authenticated user without hammering ACP API on every 150 ms flush.

## Renderer changes

File: `src/renderer/hooks/useVsqlCacheSse.ts`

- Already connected to `GET /v1/agent-output/stream?projectId=<id>&agents=<optional>&since=<optional ISO ts>`.
- Uses `Authorization: Secret <container-secret>` via main-process IPC.
- Reconnects with `?since=<last received ts>`.
- Consumes `event: agent-output` with shape `{agent, terminal_id, provider, line, ts}`.

File: `src/renderer/hooks/useAcpSse.ts`

- Removed legacy `agent-output` handling from the acp-api SSE stream to avoid duplicates.

## Not touched

- vsql-cache backend code.
- PostgreSQL schema.

## Verification

- `npm run build:electron` passed.
- `npm test` passed (59 tests).
- End-to-end round-trip verified against the running vsql-cache service:
  - POST returned `{ "accepted": true, "lines": 2 }`.
  - SSE immediately emitted the same chunk as `event: agent-output`.

## Note for this environment

The vsql-cache process currently listening on this box is bound to `10.0.0.220:52424`. The work-order target `10.0.0.93:52424` remains the compiled default; set `VSQL_CACHE_URL=http://10.0.0.220:52424` at runtime to test locally.
