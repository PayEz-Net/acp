# TO-BE: the agent stream bridge — one writer, two feeds, one home

> Status: DESIGN, pre-implementation. Written 2026-08-10 for the rig restart window.
> Every "as-is" number below was measured today, not recalled. Where something is
> inferred rather than measured, it says so.

---

## 1. Why this exists: the capture is silently empty

The system already has an agent-output cache with a controller, a scrubber, spill and
dead-letter machinery, integration tests, and a read API. **It has been empty since
2026-07-29.** Measured across every candidate home:

| home | `vibe_cache.agent_output_events` |
|---|---|
| `93:5432/vsql_cache` | **0 rows** |
| `93:5433/vsql_cache` | **0 rows** |
| `93:5433/vsqlcache` | 2 rows, newest **2026-07-29** |
| `93:5432/payez_vibe` | table does not exist |

In the current rig run: zero `agent-output` POSTs in the log, zero spill files, zero
dead-letters. So it is **not failing to deliver — it is not being fed.**

**Root cause, and it is structural rather than a bug.** The writer is
`src/main/ptyOutputReporter.ts`. It reports **PTY terminal output**. Agents that run
through the ACP protocol never touch a PTY:

```
providerConfigs.ts   kimi.supportsAcp   = true     → AcpProcess, JSON-RPC over stdio
                     claude.supportsAcp = false    → PTY
                     codex.supportsAcp  = false    → PTY
pty.ts:1272          "PTY fallback path for providers that don't support ACP (Claude, Codex)."
```

So the day the team moved to Kimi, the capture went to zero and nothing said so. This is
the same failure shape as the boot-continuity gap found the same morning: **a subsystem
that fails soft is indistinguishable from one that is working and has nothing to say.**

### 1.1 Why it matters beyond replay

Three things want this stream and none of them can have it today:

1. **Lost-turn detection.** A turn where an agent burns a full model call and the world
   does not move — reading its own echo, re-triaging a handled thread, "standing by",
   asking permission for work it already owns. Measured on the final Claude session:
   one agent spent **12 of 12** consecutive turns this way. On Kimi this is currently
   unmeasurable, because the transcripts that made it measurable are Claude-only.
2. **The ops observer.** It watches the agent stream by definition.
3. **Post-hoc audit.** "What did this agent actually do between 14:10 and 14:25" is
   currently answerable only by scrolling a pane that keeps no history.

---

## 2. Non-goals

- **Not** a second storage system. The cache exists; it gets fed.
- **Not** a rewrite of `ptyOutputReporter`. Its batching, spill, dead-letter and drop
  accounting are the hard-won parts and are reused verbatim.
- **Not** the Claude stream-json cutover (see §7). That is a separate, larger change.
- **Not** raw stream into the vector store (see §5).

---

## 3. TO-BE shape

```
   KIMI (ACP)                         CLAUDE / CODEX (PTY)
   AcpRuntimeManager                  pty.onData
   emits 'event'                            │
   AcpSessionUpdate                         │
        │                                   │
        ▼                                   ▼
   agentStreamBridge.ts  ──────────►  reportPtyOutput()
   (normalise to one record)          EXISTING transport:
                                      batch → POST → spill → dead-letter
                                              │
                                              ▼
                                      vibe-api /v1/agent-output
                                              │
                                              ▼
                                      93  vibe_cache.agent_output_events
                                          (THE RAW LEDGER)
                                              │
                             distil (findings, rulings, summaries)
                                              │
                                              ▼
                                      93  kb (pgvector)
                                          (THE MEANING INDEX)
                                          each row carries a pointer
                                          BACK to a ledger range
```

**One writer. One destination. Two feeds, because there are genuinely two sources
today** — and exactly one of them disappears when §7 lands, at which point the Claude
feed collapses into the ACP feed with no rework.

### 3.1 The tap points

| feed | where | why there |
|---|---|---|
| ACP | `pty.ts:1249` — `runtime.on('event', ...)` | The single place every ACP event already passes through on its way to the renderer. One line added beside the existing `safeSend`. |
| PTY | existing `reportPtyOutput` call sites | Already correct. Untouched. |

Tapping at `pty.ts:1249` rather than inside `AcpRuntimeManager` is deliberate: the
runtime should not know a cache exists. The subscription point already exists and
already has the terminal id, the agent name and the provider in scope.

### 3.2 What gets captured, and what does not

`AcpSessionUpdate` carries full turn structure. The bridge is selective **and says so in
code**, because a silent filter is how a capture ends up looking complete while missing
the thing someone later needs.

| update | capture | why |
|---|---|---|
| `turn_started` | **yes** | Turn boundaries are what make turns countable. Without these, "lost turns" cannot be computed at all. |
| `turn_complete` (+`stopReason`) | **yes** | Same, plus `stopReason` distinguishes a finished turn from an aborted one. |
| `agent_message_chunk` | **yes** | The prose. The primary signal. |
| `tool_call` / `tool_call_update` | **yes** | Whether a turn *did* anything is the mechanical half of lost-turn detection, and the cheap half. |
| `error`, `stderr` | **yes** | A capture that drops failures reports a healthier system than exists. |
| `agent_thought_chunk` | **yes, tagged** | High volume. Kept because thinking is where a stuck agent is visible, but tagged so consumers can exclude it cheaply. |
| `permission_request`, `wait_state` | **yes** | Both are "the agent is blocked on something" — the exact state we want to catch early. |
| `prompt_queued/dequeued`, `queue_cleared`, `available_commands_update`, `initialized`, `spawn_info` | no | Control-plane chatter; carries no work signal. |

The three the runtime itself already marks `NOISY_SESSION_UPDATES`
(`agent_thought_chunk`, `agent_message_chunk`, `tool_call_update`) are precisely the
high-frequency ones — which is why they go through the existing **batcher** rather than
one POST per chunk.

### 3.3 Record shape

Normalised so a consumer never needs to know which feed produced a row:

```
agent          BAPert
terminal_id    <ACP session id for the ACP feed, terminal id for PTY>
provider       kimi | claude | codex
kind           turn_start | text | thought | tool | tool_result | error | turn_end
seq            monotonic per (agent, session)
text           the payload, already scrubbed by the existing outputScrubber
meta           { stopReason, toolName, toolStatus } — only what the kind carries
```

`kind` is the addition that makes this better than the PTY stream it replaces. **The PTY
feed was a flat blob of terminal bytes** — ANSI escapes, cursor moves, redraws — from
which turn structure had to be re-derived by regex, badly. The ACP feed arrives already
structured, and the PTY feed maps onto the same shape with `kind: 'text'` for everything.
Consumers get one contract; the PTY side is simply lower-resolution.

---

## 4. Failure semantics

Non-negotiable, and each is a rule that already cost something:

1. **The bridge must never break a spawn or a turn.** Every call is wrapped; a bridge
   failure logs and drops that record. An agent that cannot start because telemetry
   failed is a catastrophic trade for an observability feature.
2. **It must not fail silently.** Drops are counted and surfaced through the existing
   `getDropStats()` / `TerminalDropStats` path, with a distinct `DropCause` for the ACP
   feed. A capture that loses data quietly is worse than no capture, because it produces
   confident, incomplete answers. The 12-day-empty cache is the proof.
3. **Back-pressure drops, it does not queue unboundedly.** The existing spill path
   already handles this and already has a dead-letter directory. Reused, not rebuilt.
4. **No fallback destination.** If `VIBE_API_URL` is unset the bridge logs once, loudly,
   and stays off. It does not invent a local file, because then there are two homes and
   nobody knows which has the data — the exact mechanism that produced four cache homes.

---

## 5. Storage: why the raw stream does NOT go in the vector store

The instinct to put everything in `kb` is reasonable and wrong, for three separate
reasons. Any one of them is sufficient.

**Access pattern.** "What did DotNetPert do between 14:10 and 14:25" is a time-ordered
range query over a contiguous span. Vector search answers "what resembles this", which
returns a scattering of loosely-similar fragments — the wrong shape for a replay, and it
degrades as the corpus grows.

**Contamination.** `kb` currently serves memory recall and the per-agent session
summaries — the mechanism the whole team boots from. Adding thousands of raw stream
fragments makes every recall compete against noise. `kb_search` uses
`plainto_tsquery` with AND semantics and stemming, so low-signal chunks measurably
degrade precision rather than just adding volume.

**Cost.** Every chunk would need an embedding through `nomic-embed-text`. That is a
continuous GPU load on the 220 box to embed `✓ Compiled successfully`.

### 5.1 The split, and the pointer that makes both worth having

```
CACHE  (vibe_cache.agent_output_events)   the RAW LEDGER
       high volume, time-ordered, cheap, replayable, expiring
       answers: WHAT HAPPENED, in order

KB     (pgvector)                         the MEANING INDEX
       low volume, curated, permanent, embedded
       answers: WHAT DID WE LEARN, by similarity
```

**The link is the design, not an afterthought.** Every distilled `kb` row carries a
machine-resolvable pointer back to the ledger range that produced it — `agent` plus a
time window, resolvable through the existing `GET /v1/agent-output/history` endpoint
(which already takes `agents`, `since`, `until`, `sessionId`).

That gives the property neither store has alone: **ask semantically, land on the
conclusion, follow the pointer, read the actual turns that produced it.** Today `kb.source`
is prose — "mail 26691", "measured 2026-08-10". Making it resolvable is a small change
with a large payoff, and it is what turns "we concluded X" into "here is X being
concluded."

This also fixes an asymmetry that already bit: a `kb` entry can currently cite a session
that no longer exists anywhere. With the ledger underneath, the citation resolves.

### 5.2 Retention

The ledger is expected to get large and heterogeneous. It needs a retention policy from
day one — not added later under disk pressure, which is when retention decisions get made
badly. Proposal: ledger rows expire on a fixed window (30 days, configurable); anything
that must outlive that window has to be **distilled into `kb` first**. That makes
distillation the deliberate act of promotion rather than a thing someone remembers to do.

---

## 6. Acceptance — how this gets proven, not assumed

Written as gates because "it looks wired" is what the last twelve days looked like.

**G1 — positive control, both feeds.** Start one Kimi agent and one PTY agent. After one
turn each, both appear in `vibe_cache.agent_output_events` with the correct `provider`.
*Absence of rows is a FAIL, not a pass.*

**G2 — the instrument can fail.** Point the bridge at a wrong URL. It must log loudly and
increment a drop counter. **A silent zero must be impossible to confuse with a healthy
zero.** This gate exists because that exact confusion is the whole defect.

**G3 — turn structure survives.** For one Kimi turn, the ledger contains `turn_start`,
at least one `text`, and `turn_end` with a `stopReason`, in `seq` order.

**G4 — no spawn regression.** Kill the vibe-api. Agents must still spawn and complete
turns. Bridge failure is not agent failure.

**G5 — the PTY feed is unchanged.** Existing `reportPtyOutput` tests pass untouched. This
is a strictly additive change to a working path.

**G6 — lost-turn computability.** Quinn computes a lost-turn rate for a Kimi agent from
ledger data alone, and its two-sided positive control (a known-lost turn AND a
known-productive turn, separated) still passes against ledger-sourced records.

---

## 7. What collapses when the Claude stream-json cutover lands

`feature/claude-stream-json` (on `devops`) makes Claude emit the **same
`AcpSessionUpdate` vocab** through the same runtime, and sets `claude.supportsAcp = true`.

Measured today, which is why it is **not** in this change:

- 10 commits, and our lineage is **59 commits ahead of the merge base**
- it **deletes** `claudeSession.ts` and `claudeSpawnCommand.ts` — both of which this
  lineage uses (`deriveClaudeSessionId` is load-bearing for session identity)
- it rewrites **201 lines of `pty.ts`**, a file this lineage has also changed

That is a cutover, not a merge, and it does not belong in a two-hour window before a
restart.

**The design above is built so that cutover costs nothing.** When it lands,
`claude.supportsAcp` flips true, Claude starts arriving on the ACP feed, and the PTY feed
simply stops producing Claude rows. No consumer changes, no schema change, no rework —
the record shape was designed for the structured feed, and the PTY feed was mapped onto
it rather than the reverse.

This is the specific reason two feeds is the correct intermediate rather than a
workaround: **the shape is right for the destination, not for today's sources.**

---

## 7a. Kimi `--output-format stream-json` — read from source, and why it is NOT the rig's path

Verified 2026-08-10 against `E:\Repos\kimi-code-reference` pulled to `0401ec42` (11 hours
old at time of reading), not from documentation. Two claims in circulation about this
flag are wrong in ways that would have shaped the design badly.

**It is prompt-mode only, structurally.** `apps/kimi-code/src/cli/options.ts:26`:

```ts
if (opts.prompt === undefined) return 'text';
```

The `--output-format` flag and its `KIMI_MODEL_OUTPUT_FORMAT` env var resolve to `text`
whenever `-p` is absent, and the file's own comment says the env var "is ignored outside
prompt mode so an ambient value never affects interactive `kimi`". **There is no path by
which an interactive session emits JSONL.**

**Session continuity IS available with it** — `--session <id>` / `--continue` compose
with `-p`, and `run-prompt.ts:215` writes a resume hint. So the achievable shape is:

```
kimi -p "<prompt>" --session <id> --output-format stream-json     → one turn, then exit
```

That is *a session*, but **one process per turn**. For the rig that is disqualifying, and
not for performance reasons:

- **Mail injection dies.** Kimi/Codex mail push works by writing `[ACP Mail] ...` into
  PTY stdin of a live process. There is no live stdin between turns in this model.
- **Cancel, permission requests and wait states die.** They are session-protocol
  concepts; a one-shot process has no channel for them.
- **Turn boundaries become process boundaries**, which is a downgrade — see below.

**The vocabulary is strictly poorer than ACP for our purpose.** stream-json has five
message shapes (`prompt-render.ts:77-100, 358, 366`):

| stream-json | ACP `AcpSessionUpdate` |
|---|---|
| `assistant` (`content`, `tool_calls`) | `agent_message_chunk` + `tool_call` |
| `tool` (`tool_call_id`, `content`) | `tool_call_update` |
| `meta: turn.step.retrying` | **no equivalent — see gap below** |
| `meta: resume`, `meta: version` | `initialized`, `spawn_info` |
| — | **`turn_started` / `turn_complete` + `stopReason`** |
| — | `agent_thought_chunk` (thinking is deliberately absent from JSONL) |
| — | `permission_request`, `wait_state` |
| — | `error`, `stderr` as stream events |

**The two that matter most for lost-turn detection are the two stream-json lacks.**
Explicit turn boundaries make turns countable directly; without them a consumer must
infer a turn from process lifetime. And `wait_state` / `permission_request` are the
"agent is blocked" signals — precisely the states worth catching early.

**One genuine gap in the other direction, worth carding rather than burying:**
stream-json surfaces **provider retries** (`turn.step.retrying` with attempt counts,
delay, error name and status code). ACP appears to expose no equivalent. A model
silently retrying three times is invisible to the rig today, and it is exactly the kind
of thing that reads as "the agent is slow" while being a provider fault. *Inferred from
the absence of a retry member in the `AcpSessionUpdate` union — not yet confirmed
against the runtime, so treat as a lead, not a finding.*

**Where stream-json IS the right tool:** headless, one-shot pipelines — a Kimi run on the
MacBook, a CI-invoked agent, a batch job. Those want exactly this: no terminal, no
session daemon, structured output, exit. That use case should adopt it, and this bridge
is irrelevant to it.

**Aside, no action needed:** kimi's JSONL is snake_case throughout — `tool_call_id`,
`failed_attempt`, `delay_ms`, `status_code`. Consistent with the house law, so a consumer
needs no per-field translation.

---

## 8. Open questions

1. **Does the scrubber cover ACP content?** `acp-api/api/contractors/outputScrubber.ts`
   was written for terminal bytes. ACP content blocks may carry structure it does not
   expect. **Must be checked against a real payload before shipping** — a scrubber that
   silently passes a secret is worse than no scrubber, and this is exactly the class of
   thing that looks fine until it isn't.
2. **Which cache home is canonical?** Four exist. `93:5432/vsql_cache` is the documented
   home; the others are drift. **The bridge must not pick — the config must say, and be
   read.** `SchemaInitializer` is idempotent `IF NOT EXISTS`, so pointing at a wrong
   database *creates a valid empty cache there* with no error. That is how four homes
   happened, and it will happen again.
3. **Does `agent_output_events` carry a `kind` column, or does it need a migration?**
   Unverified at time of writing. If it does not, the options are a migration or packing
   `kind` into the payload — the former is correct, the latter is how a schema rots.
4. **Should thought chunks be captured at full volume or sampled?** Captured for now,
   tagged, and revisited with a real volume measurement rather than a guess.
