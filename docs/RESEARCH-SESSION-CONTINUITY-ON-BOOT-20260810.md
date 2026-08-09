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

## 3. The blocker that turned out not to be one — SOLVED 2026-08-09

The original reading: acp-api cannot reach `kb` (the password is not in any repo), so the
read path is gated on a config decision.

**That was true and irrelevant.** It assumed the injection had to come from the profile
endpoint. The `kb_recall.py` hook ALREADY reaches `kb` on every prompt, already runs in
every ACP pane, and already knows the session. Nothing needed a new connection — the read
path was one `if` away in a file that was already deployed.

**Kept as a lesson:** a blocker attached to one design is not a blocker on the goal. The
question that dissolved it was "what already talks to kb?", not "how do we get acp-api to".

The profile-endpoint route is still the right home for KIMI, which has no hook. That
remains blocked on the connection, and only for Kimi.

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

## 7. Who fills the summary in — BUILT 2026-08-10

Nothing did, originally: `kb_session_summary.py` is a pipe. Producing the text is the
half that decides whether any of this is useful. Three candidates were considered:

- **The agent writes its own.** Highest quality — it alone knows intent, what it
  abandoned, what it never reached. But **sessions die without warning**, and the
  summaries most worth having come from sessions that ended badly.
- **A `Stop` hook.** Reliable on Claude runtimes, but `Stop` fires when the agent
  finishes *responding*, not when the session ends — a summary per turn. And Kimi has
  no hooks.
- **A local model reads the transcript.** Survives a session dying mid-thought, needs
  no cooperation from the agent, and works for **Kimi and Claude alike** because it
  reads jsonl off disk rather than hooking a runtime.

**Built: `acp-api/scripts/kb_summarize_transcript.py`** — the third. `qwen2.5-coder:7b`
on `10.0.0.220` (the ops-observer model, already running). Prints to stdout and stores
nothing, so a human or caller decides whether it is worth keeping.

**Measured on a real transcript:** it produced correct branch, commit `8745f333` and
file paths, or left the field empty — it invented nothing. It is also visibly **thin**:
a 7B yields a skeleton, not the judgement an agent would write.

**So: both, with provenance marked.** Agent-authored when there is a chance; this as the
floor. `--source` records which, because *"BAPert wrote this"* and *"a 7B inferred it
from a transcript"* deserve different trust at boot and a reader cannot otherwise tell.

**Do NOT trigger it on transcript quiet.** Claude Code writes a transcript entry when a
turn COMPLETES, so a long tool sequence is byte-identical to a wedge. Quiet-triggered
summarisation would summarise agents mid-thought. Session end, or explicit invocation.

Remaining unknown: transcript discovery. Session state lives in at least five
directories under `~/.claude` and the set has grown every time anyone looked, so
"find this agent's transcript" is its own small problem. Today the script globs
`~/.claude/projects/*/*.jsonl` and takes newest-or-by-session-id, which is adequate for
Claude and unproven for Kimi.

## 8. Recommended sequence

1. ~~**Write path**~~ — **DONE** (`kb_session_summary.py`, `kb_summarize_transcript.py`).
2. ~~**Retro-date the existing `handoff_*` memories**~~ — **DONE**, 8 expired (not
   deleted). Note the near-miss: matching `%handoff%` also caught 3 memories that are
   NOT session state — doctrine on where working docs live, the active onboarding
   bundle, and the streamjson branch handoff with open issues. All 3 restored. **Match
   on the dated session-summary shape, not the word.**
3. **Read path when acp-api has a `kb` connection** — append the latest
   `scope=agent, scope_id=<name>, expires_at > now()` summary to the profile response,
   beside the briefing.
4. **Decide the trigger.** Session end is the obvious one; the ACP shell knows when a
   pane dies and the agent does not.
5. **Revisit the briefing.** It is already a cache of the `agent-memory` skill and
   drifted twice in ninety minutes on 2026-08-10.

## 8. AS BUILT — and how to do it again

**Landing summaries at boot is live for Claude panes.** Verified 2026-08-09 on a real
restart: 6 of 7 agents received their own summary and the 7th correctly received nothing.

**Runbook — repeating a restart with continuity:**

1. **Before shutdown, nothing is required.** Transcripts are files on disk and survive the
   restart, so summaries can be produced after the fact just as well as before. This was
   the point of reading transcripts rather than hooking a runtime.
2. **After the rig is down, summarise:** for each agent, run
   `acp-api/scripts/kb_summarize_transcript.py --agent <Name> --session <id> --project-dir E--Repos`
   and pipe into `kb_session_summary.py --agent <Name> --session <id> --stamp <iso> --ttl-days 14`.
   The summariser exits non-zero and prints NOTHING when it cannot verify what it wrote, so
   a refusal stores nothing without the caller checking.
3. **Attribute transcripts by counting `X-ACP-Agent:` / `/v1/agents/<name>/profile` hits**
   per file and taking the mode. Do NOT use the `report as` prompt — it matches "report as
   me". Do NOT use it for the HOOK's identity either (see §9).
4. **Bring the rig up.** `npm run dev:prod` in `acp-desktop`. Wait for `PREDICATE_PASS`.
5. **Verify by result, not by assumption:** grep the fresh transcripts for
   `left off. This is a stored summary`. Anything else is a claim, not a check.

**Still not built:** the profile-endpoint route for Kimi (no hook, so no automatic
injection — Kimi agents must search manually). Everything else in this document is done.

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

## 9. Identity: ask the runtime — the three failures worth not repeating

Boot injection needed the agent's name. Three inferences were tried before the right one,
and **every one produced a confident wrong answer rather than a failure**, which is what
makes this class expensive:

| Inference | Why it failed |
|---|---|
| `report as <Agent>` as the prompt | The shell's first prompt is `Begin.` — no name, and six characters, **below the hook's own MIN_CHARS floor**, so it returned before doing anything |
| `X-ACP-Agent:` from the transcript | Says who the session is CALLING AS, not who it IS — my own transcript had 18 BAPert hits and would have been resolved as BAPert |
| `✓ <Agent> initialized` banner | Absent from every RESUMED session; resuming does not re-onboard. Zero matches on a real transcript, so the "safe" version silently injected nothing for everyone |

**`pty.ts:1301` sets `ACP_AGENT_NAME` per pane at spawn, and hooks inherit the
environment.** The runtime knew the whole time.

Two rules out of it, both in `kb` as standard/feedback:
- **Grep the spawner for a value that already carries the answer before writing a resolver.**
- **An unresolved identity must inject NOTHING.** Guessing hands one principal another's
  private state — which is exactly what happened when `report as QAPert` returned
  QAPert-NightHawk's summary.
