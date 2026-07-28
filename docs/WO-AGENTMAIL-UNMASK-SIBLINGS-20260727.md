# WO — agentmail repo: unmask query failures in sibling read methods

**WO ID:** WO-AGENTMAIL-UNMASK-SIBLINGS-20260727
**Author:** BAPert (spun out of WO-MAIL-SEND-PROJECT-NOT-FOUND-20260727 resolution notes)
**Date:** 2026-07-27
**Status:** CLOSED (dev) 2026-07-27 — fix + tests on dev-93, QA sign-off filed with the mail WO pass (msg 1498)
**Owner:** DotNetPert
**Verify:** QAPert
**Priority:** Normal — hardening; not user-blocking today

---

## 1. Problem

The same failure-masking pattern that caused the PROJECT_NOT_FOUND outage
(fixed in `ProjectExistsAsync`) still exists in sibling agentmail repository
methods. On a vsql query-lane failure (e.g. `TENANT_CONTEXT_REQUIRED` 500),
each silently returns an "empty" value that masquerades as a legitimate
result:

| Method | Masked return on lane failure | User-visible effect |
|---|---|---|
| `AgentMailVibeSqlMessageRepository.GetMessageAsync` | `null` | Message appears "not found" — indistinguishable from a bad id |
| `AgentMailVibeSqlMessageRepository.GetMessagesByThreadAsync` | empty list | Thread renders as empty |
| `AgentMailVibeSqlInboxRepository.GetUnreadCountAsync` | `0` | **Unread badge silently zeroes — user believes they have no mail during an outage** |

The unread-badge case is the worst: it converts a backend outage into a
false "all caught up" signal, which erodes trust in exactly the signal
agents and Jon rely on to notice new work.

## 2. Scope

1. Apply the same unmasking used in `ProjectExistsAsync`
   (`InvalidOperationException` carrying the lane error code, surfacing as
   500 via `VibeGlobalExceptionMiddleware`) to the three methods above.
   Genuine absence keeps its current contract (null / empty / 0).
2. Unit tests mirroring `AgentMailVibeSqlMessageRepositoryTests`:
   lane failure throws with the lane code; legitimate empty results still
   return as before. (PayEz.Infrastructure.Tests, xUnit+Moq+FluentAssertions.)
3. House rules apply: working tree only, Jon commits.

### Out of scope
- Sweeping other repos for the pattern beyond these three methods — if
  triage finds more, list them here before expanding.

### Found beyond the three (listed per scope rule — NOT changed)

- `AgentMailVibeSqlMessageRepository.GetProjectsAsync` → empty list on lane failure.
- `AgentMailVibeSqlInboxRepository.GetInboxEntriesAsync` → empty list (warn-logged).
- `AgentMailVibeSqlInboxRepository` single-entry getter (~L77) → null.
- `AgentMailVibeSqlInboxRepository.GetInboxEntryByMessageIdAsync` → null.
- `AgentMailVibeSqlInboxRepository.MarkAsRead` / `MarkMessageAsRead` → false (warn-logged).
- `AgentMailVibeSqlInboxRepository.MarkAllAsRead` → 0 (warn-logged).
- `AgentMailVibeSqlInboxRepository.GetInboxPage` → masks page query, but its
  empty-page fallback calls `GetUnreadCountAsync`, which now throws — net
  effect is fail-loud on lane failure even without touching this method.
- `AgentMailVibeSqlInboxRepository.GetRecipientsForMessages` → empty dict (warn-logged).
- Already fail-loud, no action: `CreateMessageAsync`, `CreateInboxEntry`
  (both log + throw on lane failure).

## 3. Acceptance criteria

1. A vsql lane failure in any of the three methods surfaces as a 500 with
   the lane error code — never as a silent null/empty/0.
2. Legitimate not-found/empty/unread-0 results are unchanged (tests prove
   both directions).
3. Test suite green; QAPert verifies on dev: unread badge and thread reads
   behave correctly during a forced lane failure (or a credible simulation),
   and normally otherwise.

---

| Role | Agent | Status |
|---|---|---|
| WO author | BAPert | ✅ Authored 2026-07-27 |
| Fix + tests | DotNetPert | ✅ 2026-07-27 — 3 methods unmasked + 7 tests, 38/38 green. Working tree only, awaiting Jon's commit. |
| QA verify | QAPert | ✅ SIGNED (dev) 2026-07-27 (msg 1498, riding the mail-WO pass) |

**Close-out note (BAPert):** AC3 evidence — normal-path reads/badge verified
live on the redeployed dev-93 build (inbox full/unread, `messages/:id`,
unread_count 4→3 across a mark-read). Lane-failure throw contract for the
three methods is evidenced by the 7 unit tests (38/38 green); the live
lane-down drill (15:45:36Z) proved the middleware surfacing (sanitized 500
client-side, lane code in Graylog) for this repository class via the
send-path equivalent. Remaining 8 masked sites tracked in
WO-AGENTMAIL-UNMASK-REMAINING-20260727.
