# WO — agentmail send rejects the session's own current project (PROJECT_NOT_FOUND, dev backend)

**WO ID:** WO-MAIL-SEND-PROJECT-NOT-FOUND-20260727
**Author:** BAPert
**Date:** 2026-07-27
**Status:** CLOSED (dev) 2026-07-27 — AC1–AC3, AC5 PASS on dev-93 with QA sign-off; **promoted** `R-Vibe-merge-20260727` (all 6 APIs healthy); AC4 disposition in §8
**Owners:** DotNetPert (cloud, primary) · NextPert (sidecar, optional UX only)
**Verify:** QAPert
**Found during:** Jon's build-93 test pass against the Azure dev backend

---

## 1. Problem

All agent mail send fails on build 93 pointed at the Azure dev backend:

```
POST http://127.0.0.1:3001/v1/mail/send
→ {"success":false,"error":{"code":"PROJECT_NOT_FOUND","message":"Project with id 284 not found"}}
```

Reproduced 3/3, including once with a forced-fresh cache (see §2). Inbox
reads still work, so the failure is silent until someone sends. **This bug
also blocks its own notification — it cannot be routed by agent mail.**

## 2. Evidence — this is NOT a stale-cache bug

First hypothesis (sidecar stamps a stale prod id) was tested and **disproven**:

```
GET http://127.0.0.1:3001/v1/projects/current        (seconds later, same session)
→ 200 success, source: "cloud", freshly fetched:
   project 284 "Jon93Test", status: active, owner_user_id: 22,
   current_project_id: 284, current_project_state: "stored"
```

Immediately after that refresh, send failed again with the identical error.

So: **the sidecar stamps the correct, cloud-confirmed current project id, and
the agentmail send endpoint rejects the very id the projects endpoint just
returned.** Both routes proxy to the same `VIBE_API_URL` host — the
contradiction is inside the dev backend.

## 3. Root-cause hypotheses (DotNetPert to confirm)

Ranked, all cloud-side:

1. `/v1/agentmail/send` validates `project_id` against a different
   store/table/scope than `/v1/projects/current` — dev data drift between the
   two (e.g. separate agentmail schema missing project 284).
2. Project 284 exists but was never provisioned for agentmail on dev
   (missing agentmail-side project/membership seed rows).
3. The validation is scoped to something narrower (owner vs member vs engaged
   team) and the error message misreports that as "not found".
4. Dev routes `/v1/agentmail/*` and `/v1/projects/*` to different service
   instances backed by different databases.

## 4. Scope

### DotNetPert — cloud (primary)

1. Find why `agentmail/send` rejects project 284 while `projects/current`
   confirms it (start with the project-existence query in the send path).
2. Fix the inconsistency — code or dev seed data, whichever is at fault.
3. Align the error contract with reality: if a project exists but is not
   mail-enabled, return a precise code (e.g. `PROJECT_NOT_MAIL_ENABLED`),
   not `PROJECT_NOT_FOUND`.

### NextPert — sidecar (optional, UX only)

4. No stamp defect found — the sidecar sends the right id. Optional: surface
   the cloud error body verbatim in the desktop renderer so testers see
   `PROJECT_NOT_FOUND` instead of a generic send failure.

### Out of scope

- Sidecar cache-invalidation work (moot — cache was fresh and correct).
- Inbox/read paths (unaffected).

## 5. Acceptance criteria

1. On build 93+ against the dev backend, `POST /v1/mail/send` with the
   sidecar-stamped current project id delivers successfully.
2. `/v1/projects/current` and `/v1/agentmail/send` agree on project existence
   for the same backend + session.
3. Any remaining rejection returns an error code that matches the actual
   problem.
4. No regression on prod config: send still stamps and delivers.
5. QAPert sign-off on dev backend.

## 6. Notes

- Project under test: id 284 "Jon93Test" (created 2026-07-13, owner user 22,
  2 members / 5 team members, repo `e:/repos`).
- Mail routing of this WO is blocked by the bug itself; BAPert will re-send
  the assignment mail once cloud is fixed, or Jon can hand it off directly.
- **Resolution notes (DotNetPert, 2026-07-27):** Confirmed root cause =
  hypothesis 3 with a masking layer. `AgentMailService.SendMailAsync` →
  `AgentMailVibeSqlMessageRepository.ProjectExistsAsync`
  (PayEz.Services/PayEz.Infrastructure/Repositories/Vibe/AgentMailVibeSqlMessageRepository.cs)
  returned `false` on ANY vsql query failure; the lane was 500ing
  `TENANT_CONTEXT_REQUIRED` (dropped ambient client-id fallback, fixed by
  `df4a811a5`). Each of the 3 failing sends is followed 2–13ms later by a
  `TENANT_CONTEXT_REQUIRED` /v1/query 500 in Graylog. Unmasking change:
  query failure now throws `InvalidOperationException` with the lane error
  code (surfaces as 500 via VibeGlobalExceptionMiddleware) instead of
  `false` → 404 PROJECT_NOT_FOUND. Covered by
  `PayEz.Tests/PayEz.Infrastructure.Tests/AgentMailVibeSqlMessageRepositoryTests.cs`
  (3 tests, 31/31 green).
- Same masking pattern still present in sibling methods/repos
  (`GetMessageAsync` → null, `GetMessagesByThreadAsync` → empty,
  `AgentMailVibeSqlInboxRepository.GetUnreadCountAsync` → 0) — follow-up
  hardening, not blocking this WO.

---

| Role | Agent | Status |
|---|---|---|
| WO author | BAPert | ✅ Authored 2026-07-27 (root cause corrected after live probe) |
| Cloud fix | DotNetPert | ✅ 2026-07-27 — tenant-context fix `df4a811a5` verified live on dev-93 (send green, msgs 1470/1471; zero TENANT_CONTEXT_REQUIRED/SCHEMA_REQUIRED since 14:21Z). Repo unmasking + unit tests committed `fae783ff7` (31/31 green); redeployed to dev-93 15:13Z (BAPert). |
| Sidecar UX (optional) | NextPert | ⬜ Open |
| QA verify | QAPert | ✅ SIGNED (dev) 2026-07-27 (msg 1498) — AC1–AC3 PASS, AC4 deferred to promotion by design |

## 7. Close-out (BAPert, 2026-07-27)

Criterion-level evidence:

- **AC1** (send with sidecar-stamped id delivers): msgs 1473, 1487, 1492,
  1493, plus this thread — all delivered under project 284 post-fix.
- **AC2** (endpoints agree): `projects/current` and `agentmail/send` both
  affirm project 284 (Jon93Test, active).
- **AC3** (error code matches reality): forced lane failure 15:45:36Z
  (vibe-serverapi stopped) → sidecar send returns sanitized HTTP 500
  INTERNAL_ERROR; Graylog `VIBE_UNHANDLED_EXCEPTION` carries the lane code
  verbatim (`CONNECTION_ERROR: Failed to connect to VibeSQL Server`) via the
  unmasked `ProjectExistsAsync` path — never a fake 404. Genuine absence:
  direct HMAC call `project_id=999999` → exact 404 PROJECT_NOT_FOUND.
- **AC4** (prod regression): deferred to promotion time by design; re-arms
  when this change promotes.
- **AC5** (QA sign-off, dev): filed msg 1498.

For the record — QAPert's candor notes (msg 1498): (1) QA evidence was
sidecar-side only; DotNetPert's Graylog report is the drill record of the
server-side entry. (2) His 15:45:12Z retry returning 201 is explained by
msg 1496: the docker stop completed ~15:45:2xZ, so that send preceded the
down window (~15:45:2x–15:47Z); DotNetPert's 15:45:36Z probe was inside it.
No counter-evidence, no open anomaly.

---

## 8. Promotion record (BAPert, 2026-07-27)

Promoted to AKS as `R-Vibe-merge-20260727` (DotNetPert, rolled out ~17:14Z):
all 6 APIs live, vibe-api pod 1/1 Running with 0 restarts, startup schema
migration clean (`upgraded=0` — prod already carried the session tables),
external health `api.idealvibe.online/health` 200. Migrations applied by Jon
solo (agents hold no DB access): `20260724_TeamAgentInstancePlacementOverrides`
(gated the vibe-api rollout) and `20260604_207_drop_team_agent_instance_name_columns`.

**AC4 (prod regression) disposition:** Jon ruled the target environment is
stage with no customer exposure and directed close-out without a synthetic
credential probe. Evidence basis: the promoted code is commit-identical to
the build QAPert verified exhaustively on dev-93 (send/inbox/unread/mark
paths, both directions); the rollout itself is clean; the unmasked failure
behavior means any lane failure on this environment now surfaces loudly
(500 + lane code) rather than masquerading. First organic traffic serves as
the live confirmation.
