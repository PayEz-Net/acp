# RESEARCH — session summaries in the vector store, injected on boot

**2026-08-10 · Claude, at Jon's direction · research only, nothing built**

> **Question (Jon):** *"can we dump summaries of session in there and have them jump in
> on boot"*

Short answer: yes, and the write half is nearly free. The read half has one real blocker
(acp-api cannot reach `kb`) and three failure modes that decide whether this helps or
actively misleads the team. Those are the substance of this document.

---

## 1. We already do this. Badly.

The store already contains **7 `handoff_*` memories** — `handoff_bapert_2026-03-20`,
`handoff_bapert_2026-03-26`, `handoff_aurum_2026-03-13`, `handoff_aurum_2026-03-14`,
`nextpert-handoff-20260221`, and others. They are session summaries in everything but
name.

Three things are wrong with them, and they map exactly onto what a real design has to fix:

| Today | Consequence |
|---|---|
| Written by hand, when someone remembers | Coverage is arbitrary; most sessions leave nothing |
| **Permanent** — no `expires_at` | `handoff_bapert_2026-03-20` is five months stale and still fully retrievable |
| Nothing reads them at boot | They surface only if a prompt happens to match |

So this is not a greenfield feature. It is **finishing something half-built**, and the
half that exists is the half that rots.

## 2. Where the read belongs: the profile endpoint, not a hook

Onboarding's first act is `GET /v1/agents/{name}/profile` (see
`acp-api/api/routes/agents.ts`, and the `agent-onboarding` skill). We already append the
memory briefing there. Appending the agent's most recent session summary makes the boot
sequence:

```
who you are   (persona, from the cloud doc-store)
+ how memory works   (briefing, appended 2026-08-10)
+ where you left off   (this proposal)
```

**Why not a SessionStart hook:** at session start the agent has no identity yet — the
identity arrives as the first prompt (`report as BAPert`, injected by `pty.ts`). A hook
firing before that has no key to look up. The profile call is the first moment the name
is known, which makes it the earliest correct insertion point.

**And it covers Kimi.** Automatic recall is a Claude Code `UserPromptSubmit` hook; Kimi
has no hooks and would get nothing from a hook-based design. Both runtimes call the
profile endpoint.

## 3. The blocker: acp-api cannot reach `kb`

Every existing tool in this system (`kb_recall.py`, `kb_remember.py`, `kb-ask.py`) reaches
the store the same way:

```
ssh dotnetpert@10.0.0.93 → sudo docker exec -i kb-postgres → psql
```

That is fine for a local script and **wrong for the API**. acp-api would need a real
connection to `10.0.0.93:54320`, and the `kb` password is deliberately not in any repo
(see `reference_acp_shared_knowledge_rag_93`).

**So the read path is gated on a config decision, not on code.** A `KB_URL` /
`KB_PASSWORD` in acp-api config, sourced the same way its other secrets are. Until that
exists, the read path cannot be built honestly — and shelling out to ssh from the API to
avoid the conversation would be the wrong kind of clever.

## 4. The write path is independently useful and unblocked

`kb_remember.py` already does everything needed:

```bash
python kb_remember.py --title "BAPert session 2026-08-10 — where I left off" \
  --scope agent --id BAPert --ttl 14d \
  --source "BAPert, session <id>, 2026-08-10T18:40Z"
```

`--scope agent --id <AgentName>` is the existing scoping model, and **`kb_search`'s scope
filter applies before ranking**, so an agent's own summaries cannot leak into another
agent's results.

Written summaries are useful *before* the boot injection exists, because the recall hook
already retrieves them when a prompt is relevant.

**Sessions die without warning**, so this cannot depend on an agent remembering to write
one at the end. For Claude runtimes a `Stop` hook can do it unattended. Kimi has no hook
and would need it in-band — an unsolved asymmetry, and the reason the write path should
not be designed hook-only.

## 5. Three failure modes — the part worth arguing about

### 5.1 A summary injected at boot reads as CURRENT STATE. It is not.

This is the one that does damage. A summary is true as of a timestamp; at boot it is
presented as the world. If a deploy landed, another agent shipped, or a branch moved
since, the agent starts **confidently wrong** — and confidently wrong at boot is worse
than blank, because it does not go looking. It has an answer.

This is the same class as the standing warning on every retrieved memory ("point-in-time
notes, not live state"), but sharper: normal retrieval competes with the current
conversation, whereas a boot injection *is* the agent's entire initial picture.

**Required if this is built:** timestamp in the first line, an explicit *"verify before
acting on any `file:line` here"*, and a bias toward *state and next action* over
narrative.

### 5.2 Summaries of summaries drift

If each session summarises the last summary, errors compound with nothing to diff
against. **Inject the latest one, not a history**, and write each summary from the
session, not from its predecessor.

### 5.3 It costs boot context, every boot, forever

On top of the briefing. Keep it short and scoped. A summary that grows into a narrative
is a tax on every session the agent ever runs.

## 6. TTL matters more here than anywhere else

A session summary with no expiry is a landmine. `handoff_bapert_2026-03-20` proves it —
five months old, permanent, retrievable today, and describing a world that no longer
exists.

`expires_at` (added 2026-08-10) is what makes this safe: `--ttl 14d` and stale continuity
stops being injected on its own. **Expired is not deleted**, so the history remains
queryable for anyone reconstructing what happened.

The 7 existing `handoff_*` memories should be retro-dated as part of this work, or they
will keep surfacing beside fresh ones.

## 7. Recommended sequence

1. **Write path now** — unblocked, independently useful, no API change. Includes deciding
   who writes (Stop hook for Claude; open question for Kimi) and the summary's shape.
2. **Retro-date the 7 existing `handoff_*` memories.** They are the same object and
   currently permanent.
3. **Read path when acp-api has a `kb` connection** — append the latest
   `scope=agent, scope_id=<name>, expires_at > now()` summary to the profile response,
   beside the briefing.
4. **Revisit the briefing.** It is already a cache of the `agent-memory` skill and drifted
   twice in ninety minutes on 2026-08-10. Adding continuity to the same response makes
   that response the single most important boot surface in the system — worth a deliberate
   look at what belongs there rather than accreting.

## 8. Open questions

- **What is a "session summary"?** State + next action + open blockers is the useful
  minimum. A narrative of what happened is what people write and is not useful at boot.
- **Who writes Kimi's?** No hooks. In-band instruction is unreliable; the ACP shell might
  be better placed than the agent.
- **One summary or a short chain?** §5.2 argues one. A 2–3 entry chain may be worth it for
  long multi-day work — undecided.
- **Does the summary belong to the agent or the project?** `scope=agent` is proposed here,
  but work is project-scoped and agents move between projects. `agent` + project mentioned
  in the body is the pragmatic start; `scope=project` may be the better key.
- **What happens on a genuinely fresh start?** No summary should mean no injection, not an
  empty section — an empty "where you left off" heading invites the model to invent one.

## Related

- `E:\Repos\about_acp_vector_project.md` — the store, the migration, the two `kb_search`
  defects, permanent-vs-note
- `.claude\skills\agent-memory\SKILL.md` — how agents use the store today
- `acp-api/api/routes/agents.ts` — profile endpoint, `MEMORY_BRIEFING`,
  `withMemoryBriefing()`
- `project_be_jon_observer` (kb) — the "knowledge half rides RAG + onboarding profile"
  idea this is a concrete instance of
