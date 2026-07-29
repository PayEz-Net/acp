# WO-INTERRUPTIBLE-TURNS — working ideas

Status: IDEAS (not yet scheduled). Origin: observer finding #7 (2026-07-28),
Jon's architecture review after the SESSION_INACTIVE + silent-lead incidents.

## Problem

The ACP turn model is a single lane: one in-flight turn, human input, teammate
mail, and the agent's own task all serialize through it, and assistant text is
only guaranteed visible at turn end. That model was built for "a user drives a
CLI", not for an agent juggling a human, seven teammates, and a task list.

Everything we bolted on to cope — steer passthrough, prompt queues, the
human-reply backstop, warning steers, cancel-with-apology nudges — is priority
scheduling implemented OUTSIDE the scheduler. It works, but it is timing-based
guesswork by construction, and it will keep generating spaghetti until the
primitive exists one layer down.

## Design principle (Jon, 2026-07-28) — action stays with the actors

The rig is not a clawbot on a loop. Platform machinery must not reach into a
running agent and yank it around on a timer as a matter of course. The human
and the agents are the actors; the platform's job is to give them **lanes and
primitives**, and to guarantee *delivery and visibility* — not to guarantee
interruption. Concretely:

- The agent is asked, and decides. The human is answered, guaranteed.
- Platform force (cancel/kill) is reserved for genuinely wedged/zombie state,
  and when it fires the agent is always told why and what to do next.

The two-stage backstop (warning steer → informed cancel) already leans this
way; this doc is about making the *adapter* share the load so the desktop can
stop guessing.

## Proposal: priority input lanes + pause/resume at step boundaries

### 1. Input lanes in the adapter (kimi fork)

Today `session/prompt` is one channel; steer absorbs input "at the next step"
with no notion of who sent it. Give input explicit lanes:

| Lane | Sources | Semantics |
| --- | --- | --- |
| `human` | the desktop user | Checkpoint-eligible (see 2). Never silently reordered behind mail. |
| `mail` | teammate notices, system | Absorbed at next step, as steer does today. Never blocks the human lane. |
| `control` | platform (cancel, kill, watchdog) | Reserved for wedged state; always logged + narrated to the agent. |

The desktop tags each `session/prompt` with its lane (one optional field —
backward compatible: absent = `human`, preserving today's behavior for
existing clients).

### 2. Turn checkpoint (pause/resume), not cancel

The core primitive. When a `human`-lane message arrives mid-turn:

1. The adapter finishes the **current step** (the in-flight tool call or the
   current LLM step) — never cuts mid-tool-call.
2. It **checkpoints**: closes the step, preserves the task list/todo state,
   emits the turn boundary so pending text flushes to the client.
3. It opens a **reply turn** for the human's message.
4. When the reply turn ends, the adapter **resumes** the paused task turn —
   the agent picks up its task list where it left off, explicitly told it is
   continuing, not starting over.

The agent can also **decline the checkpoint** for one step ("mid atomic
migration, 20s") by continuing its turn; the lane guarantee is that the human
is answered at the *next* step boundary, not instantly. The agent stays an
actor; the human's guarantee degrades from "within 60s" to "at the next
natural seam, seconds away almost always" — a trade Jon explicitly prefers
over cut tasks.

### 3. What the desktop keeps, retires, and simplifies

Retires when 1+2 land:

- `HUMAN_REPLY_WARN_MS` / `HUMAN_REPLY_GRACE_MS` timers (the guessing).
- The wrap-up warning steer (the adapter checkpoint subsumes it).
- The "you were cut off mid-task" nudge (resume is now adapter-native).

Keeps (these were never spaghetti):

- Steer itself — the seed of the lanes.
- Cancel/kill paths for genuinely wedged turns (watchdog, zombie-at-resume,
  busy-reject cap) — the `control` lane.
- The spawn banner / spawn_info — observability, unrelated but proven.

Simplifies: the human-reply backstop collapses from "timer + warning + cancel
+ nudge" to "tag human prompts with the human lane". Mail injection already
has the right semantics and just gets the `mail` tag.

## Fork work items (kimi-code acp-adapter)

Validate each against the fork source before scheduling — these are the seams
as understood from behavior, not from a code read:

1. `session/prompt` accepts optional `lane` (default `human`).
2. Steer queue becomes per-lane; human entries trigger checkpoint-at-step-end
   instead of plain absorption.
3. Checkpoint: end current turn with a distinct stopReason (e.g.
   `paused_for_human`) so clients can render the seam honestly.
4. Resume: after the reply turn's end_turn, the adapter re-enters the paused
   task with a synthetic "continue your task" context note — no desktop
   involvement.
5. Decline path: one explicit step of grace when the agent is mid-atomic-work;
   bounded (one step, not infinite).

## Desktop work items

1. Tag `prompt()` as `human`, `injectMail()` as `mail`, backstop/system as
   `control`; delete the two-stage backstop timers.
2. Render `paused_for_human` as a visible seam in the transcript ("paused to
   answer Jon — will resume").
3. Keep cancel paths, routed through the `control` lane, with the existing
   narrated-to-the-agent behavior.

## Non-goals

- No mid-tool-call preemption. Atomicity of a tool call is the agent's.
- No platform-initiated "politeness" automation (auto-nags, auto-pauses on a
  schedule). Lanes and primitives only; the actors act.
- No change to mail discipline ("silence is the default") — that norm works;
  it was the missing human lane that broke it.

## Open questions

- Does the fork's resume survive a desktop restart mid-checkpoint (paused task
  turn persisted in the session file)? If not, checkpoint state needs to ride
  the session, not process memory.
- Multi-message coalescing: three human messages during one long step — one
  reply turn or three? (Lean: one, messages concatenated in arrival order.)
- Scouts on long autonomous lanes: is a checkpoint-eligible human message the
  right default there too, or do scouts default to mail-lane semantics with
  human-as-control? (Lean: same rule for all — Jon's 60s pain was with the
  lead, but silence is silence.)

## Migration

Phase A (fork): lanes + checkpoint/resume behind a capability flag; desktop
detects and uses it when advertised. Phase B (desktop): delete the backstop
timers when the floor version of the fork advertises lanes everywhere. Until
then the two-stage backstop remains the shipping behavior — scaffolding with
an expiration condition, not architecture.
