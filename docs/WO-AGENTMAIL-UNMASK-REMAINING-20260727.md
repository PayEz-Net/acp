# WO — agentmail repo: unmask remaining masked query/mutation sites

**WO ID:** WO-AGENTMAIL-UNMASK-REMAINING-20260727
**Author:** BAPert (from DotNetPert's inventory in WO-AGENTMAIL-UNMASK-SIBLINGS-20260727 §2)
**Date:** 2026-07-27
**Status:** CLOSED (dev) 2026-07-27 — committed `d17f79ea9`, deployed on dev-93, QA sign-off PASS (msg 1507)
**Owner:** DotNetPert
**Verify:** QAPert
**Priority:** Normal — hardening backlog; behind vault fix + any stripe work

---

## 1. Problem

The failure-masking class of bug behind the PROJECT_NOT_FOUND outage
(throwing lane error swallowed → fake "empty" result) survives at 8 more
sites in the agentmail repositories, inventoried by DotNetPert during the
siblings WO (listed per the expand-only-after-listing scope rule; unchanged
so far):

| Site | Masked return on lane failure | User-visible effect |
|---|---|---|
| `MessageRepository.GetProjectsAsync` | empty list | Project picker/scope renders empty during outage |
| `InboxRepository.GetInboxEntriesAsync` | empty list (warn-logged) | Inbox renders "no mail" during outage |
| `InboxRepository` single-entry getter (~L77) | null | Entry appears not found |
| `InboxRepository.GetInboxEntryByMessageIdAsync` | null | Entry appears not found |
| `InboxRepository.MarkAsRead` / `MarkMessageAsRead` | false (warn-logged) | **User believes mail was marked read when it wasn't — silently wrong state** |
| `InboxRepository.MarkAllAsRead` | 0 (warn-logged) | Same — "mark all read" silently no-ops during outage |
| `InboxRepository.GetInboxPage` | masks page query | Currently transitively fail-loud via `GetUnreadCountAsync` fallback — see §3 note |
| `InboxRepository.GetRecipientsForMessages` | empty dict (warn-logged) | Recipient lists render empty |

Already fail-loud, explicitly out of scope: `CreateMessageAsync`,
`CreateInboxEntry` (log + throw on lane failure).

## 2. Scope

1. Apply the established unmask pattern (`InvalidOperationException`
   carrying the lane error code → 500 via `VibeGlobalExceptionMiddleware`)
   to the sites above. Genuine absence contracts unchanged
   (null / empty / 0 / false stay as they are for real results).
2. Unit tests mirroring the existing unmask test sets: lane failure throws
   with the lane code; legitimate results unchanged — both directions.
3. House rules: working tree only, Jon commits.

## 3. Design note — `GetInboxPage`

Since the siblings WO, this method is *transitively* fail-loud: its
empty-page fallback calls `GetUnreadCountAsync`, which now throws. Decide
during implementation whether to leave that (works, but the failure surface
is incidental) or unmask the page query directly (cleaner contract). Either
is acceptable; state the choice in the WO when done.

**Decision (DotNetPert, 2026-07-27): unmasked directly.** The page query now
throws on lane failure with its own operation context ("Get inbox page
failed …"), so the 500 surface is deliberate at this site rather than an
accident of the fallback. The `GetUnreadCountAsync` fallback is retained for
genuine empty pages only (filtered page with no results still returns the
correct unread count) — covered by
`GetInboxPageAsync_GenuineEmptyPage_ReturnsEmptyWithUnreadFromFallback`.

## 4. Implementation notes (DotNetPert, 2026-07-27)

- All 8 sites unmasked with the established pattern. The inbox repo's 7
  sites route through a new private `ThrowOnLaneFailure(result, operation)`
  helper (one code path, per-method operation context in the message);
  `GetProjectsAsync` uses the inline form for consistency with its class.
- Genuine-absence contracts unchanged and test-proved: null / empty / 0 /
  false / true-for-mark-success all behave as before on real results.
- Tests: 18 new (16 inbox + 2 message) mirroring the established sets;
  `PayEz.Infrastructure.Tests` 56/56 green.
- House rules: working tree only, Jon commits. Files:
  `AgentMailVibeSqlMessageRepository.cs`, `AgentMailVibeSqlInboxRepository.cs`,
  `AgentMailVibeSqlMessageRepositoryTests.cs`,
  `AgentMailVibeSqlInboxRepositoryTests.cs`.
- Note: the same tree also still holds the siblings-WO changes awaiting the
  same commit (BAPert msg 1500).

## 5. Acceptance criteria

1. Lane failure at any listed site surfaces as 500 with the lane error
   code — never a silent empty/null/false/0.
2. Legitimate empty/absent results unchanged (tests prove both directions).
3. PayEz.Infrastructure.Tests suite green.
4. QAPert verifies on dev: inbox/thread/read-marking behave correctly during
   a forced lane failure (or credible simulation) and normally otherwise.

---

| Role | Agent | Status |
|---|---|---|
| WO author | BAPert | ✅ Authored 2026-07-27 |
| Fix + tests | DotNetPert | ✅ 2026-07-27 — 8 sites unmasked + 18 tests, 56/56 green. GetInboxPage decision: unmasked directly (§3). Working tree only, awaiting Jon's commit. |
| QA verify | QAPert | ✅ SIGNED (dev) 2026-07-27 (msg 1507) — AC1 on test + drill evidence (no second lane outage called for); AC2 live-confirmed (empty unread list, count 0 after read-all); AC3 suite 56/56 at d17f79ea9; AC4 live normal paths exact (send/agents/projects/inbox/mark/mark-all) |

**Close-out note (BAPert):** The agentmail failure-masking class is now fully
unmasked across the inventoried surface (ProjectExistsAsync → 3 siblings →
these 8 + GetInboxPage), with matching test coverage at every site and live
dev verification at each stage. Deployed on dev-93; committed `d17f79ea9`.
Prod regression posture re-arms at promotion, same as the mail WO.
