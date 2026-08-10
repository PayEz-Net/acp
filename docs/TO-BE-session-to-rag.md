# TO-BE: continuous session → RAG, extracted by a local model

> Status: DESIGN. Written 2026-08-10 before the restart. Depends on gate G1 of
> `TO-BE-agent-stream-bridge.md` (the ledger actually receives writes) — building this
> on an unverified source would repeat the soft-fail that left the cache empty 12 days.

---

## 1. The correction that drives this design

An earlier draft said: cache = raw ledger, `kb` = distilled index. Jon's correction:
**push far more into RAG, do not let the cache be where the value sits.**

He is right, and the reason is a property of the two stores rather than taste:

- The **cache expires**. It is high-volume, ACP-internal, and needs a retention window
  or it eats the disk. Anything whose only copy is there **dies on that window.**
- **`kb` is permanent, embedded, and reachable by every agent on every boot.**

So the ledger is not the destination. It is the *evidence*, and it is short-lived. The
extractor's job is to move everything of durable value **out of it and into RAG, while
it still exists.** Cache retention becomes a deadline, not a storage policy.

This also fixes the thing that made shutdown-only summarisation fragile: value was
accumulating in a place that had no path into memory except me, by hand, at the end.

---

## 2. What currently happens, and why it cannot continue

Today: at shutdown, I read seven Claude transcripts and hand-write seven summaries into
`kb`. That worked this morning (ids 1019–1025) and it has four defects:

1. **Claude-only.** It reads `~/.claude/projects/*.jsonl`. Kimi writes none. The moment
   the rig switched runtimes the input disappeared — measured today: transcripts froze
   34 minutes before I looked.
2. **Shutdown-only.** A crash loses the whole session. Nothing is written until the end.
3. **Expensive.** Flagship tokens spent reading transcripts and composing prose.
4. **One blob per agent.** A 4,000-character summary is one `kb` row. `kb_search` ANDs
   its terms, so a single dense row competes badly against a specific question. **Seven
   blobs is not seven-agents-of-memory; it is seven documents that each match rarely.**

Defect 4 is the one nobody would have noticed. It looks like memory and retrieves like a
filing cabinet.

---

## 3. TO-BE: many typed records, not one summary

The extractor emits **one `kb` row per durable fact**, not one row per session.

| type | what it captures | scope |
|---|---|---|
| `decision` | a ruling that closes a question | `project` |
| `finding` | a measured fact, with the measurement | `project` |
| `correction` | a claim that was wrong, and what replaced it | `project` |
| `convention` | a rule that should bind future work | `standard` |
| `blocker` | what is stopping something, and who owns it | `agent` |
| `handoff` | where an agent left off | `agent` |

Only `handoff` resembles today's summary, and it is the *smallest* of the six.

**Why typed rows beat a blob:** a question like "is the workflow schema tenant-scoped"
should hit one 300-character `decision` row containing that exact phrasing. Today it
competes against a 4,000-character wall in which the answer is one clause. Retrieval
quality is dominated by chunk focus, not corpus size.

### 3.1 Every row carries its evidence

```
title     searchable. Contains identifiers BOTH ways (see 3.2).
chunk     usable ALONE. Someone reading only this row must be able to act.
source    ledger pointer: agent + [since,until] — resolvable through
          GET /v1/agent-output/history. Plus the verbatim quote it came from.
scope     agent | project | standard
```

The **ledger pointer is the part that makes a local model safe to use here.** A row is
never "trust me": it says which turns produced it, and while the cache window holds, the
raw turns can be read back. `kb.source` is prose today ("mail 26691"); this makes it
resolvable.

### 3.2 A writing rule the extractor must obey

`kb_search` uses `plainto_tsquery` — every term ANDed, English stemming — and
**snake_case identifiers are SPLIT AND STEMMED**: `agent_output_events` becomes
`agent` & `output` & `event`, and a query for the exact token returns nothing. camelCase
survives whole.

So the extractor prompt must require identifiers written **both ways** in the chunk:
`agent_output_events` *and* `agentOutputEvents`, `vsql_cache` *and* "vsql cache". This is
not cosmetic — it is the difference between a row that is retrievable and one that is
merely stored.

---

## 4. Triggers

1. **On command** — `POST /v1/agents/:agent/extract?since=…`. Build first: it is the
   whole feature, manually fired, and it makes every other trigger a scheduler.
2. **On turn boundary** — the ledger now carries `turn_end` with `stopReason`. Extract
   every N turns, or on any turn that contained a `tool` record (a turn that did work is
   a turn worth reading).
3. **On shutdown** — retained as a final flush, no longer the only path.

**Not on a timer.** A fixed interval extracts idle periods and produces rows that say
nothing, which is how a knowledge base fills with noise that outvotes signal.

---

## 5. Quality control: extraction is cheap, promotion is not

A local 7B writing memory the whole team boots from is a real risk. Today five capable
agents produced roughly a dozen confident wrong claims; a 7B will do worse. So the model
is not trusted to *decide* — only to *notice*.

```
qwen EXTRACTS     candidates, each with a verbatim quote + ledger pointer
                  written to kb with expires_at = now + 7 days
                  title prefixed [UNRATIFIED]

RATIFICATION      the owning agent at next boot, or a reviewer, confirms or corrects
                  → expires_at = NULL, prefix removed
                  → unconfirmed rows simply age out
```

**`expires_at` already exists in the schema, so the aging path needs no new machinery.**
That is the whole safety property: nothing rots into permanent memory unattended, and
the failure mode of an inattentive week is an empty week, not a poisoned store.

### 5.1 The rule that prevents drift

**Every extraction reads the RAW LEDGER RANGE. Never a previous summary.**

Summarising summaries is telephone: drift compounds, each pass looks reasonable, and
nobody can see it happening because each step is individually defensible. The ledger is
right there; there is no reason to read anything else.

### 5.2 Deduplication

`kb.content_sha` makes byte-identical re-ingest idempotent. It does **not** catch near
duplicates, and an extractor running every N turns will produce many. Before writing,
the extractor queries `kb_search` for its own candidate and skips on a high-similarity
hit above threshold. Cheap, and it is the difference between a store that accumulates
and one that silages.

---

## 6. Acceptance

**G1 — provider-agnostic.** Extraction produces rows for a Kimi agent, from ledger data
alone, with no Claude transcript present.

**G2 — survives a crash.** Kill the rig mid-session. Everything up to the last extraction
is in `kb`. Loss is bounded by the interval, not the session.

**G3 — retrievable, not merely stored.** For five known facts from a session, a
`kb_search` with a natural question returns the right row in the top 3. *This gate exists
because "it wrote rows" is not the same as "it can be recalled", and today's blob
summaries would likely fail it.*

**G4 — evidence resolves.** Pick 5 rows at random; each `source` pointer resolves to real
turns through `/v1/agent-output/history` while the window holds.

**G5 — nothing unratified becomes permanent.** Extract, wait past the window with no
ratification, confirm the rows are gone.

**G6 — positive control on the extractor.** Feed it a range containing a known decision
and a known idle stretch. It must emit the decision and emit **nothing** for the idle
stretch. An extractor that always finds something is not an extractor.

---

## 7. Open questions

1. **Who ratifies by default?** The owning agent at next boot is cheapest and keeps the
   human out of it, but an agent ratifying its own extraction is a weak check — it is the
   same context that produced the claim. A cross-agent reviewer is stronger and costs
   more. **Jon's call.**
2. **What cache retention?** 30 days proposed. It is the deadline for promotion, so it
   sets how long an unextracted session stays recoverable.
3. **Does `standard` scope need a stricter gate?** A `convention` row binds future work
   across every project. That is the highest-blast-radius row type and probably should
   never be written by a 7B without a human, even ratified.
4. **Does the extractor see `thought` records?** They are the richest signal for "what
   was the agent actually reasoning about" and the highest volume. Unmeasured either way.
