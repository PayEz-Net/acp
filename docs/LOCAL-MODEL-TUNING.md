# Local-model tuning — the rules, and the failures that produced them

The rig runs three local-model services against **one 8 GB card** (RTX 3070
laptop, `10.0.0.220:11434`). It bursts: .NET builds and mail floods arrive
together. Everything below exists because a specific thing broke.

**`10.0.0.220` is this laptop.** `localhost:11434` and `10.0.0.220:11434` are the
same Ollama and the same card — callers use both spellings and neither is wrong.
There is no second GPU box to fall back to, which is why every rule here is about
sharing one 8 GB card rather than distributing load.

## The one rule that matters

> **Every Ollama caller on this box MUST request the same `num_ctx`.**
> If you change it, change it in all five files in the same commit.

**Why.** Ollama keeps a **separate loaded model instance per context size**. Two
callers asking for different sizes do not share one model — they load two, and
on an 8 GB card the second evicts the first. Then the first caller's next
request reloads and evicts the second. They thrash, and anything issued during a
swap comes back as a client-side timeout or a bare `ollama HTTP 500`.

**Measured 2026-08-15.** `qwen2.5-coder:7b`'s default context length is **32768**
(`ollama show`). Three callers set no `num_ctx` and therefore loaded a 6.8 GB
instance at 32K; two set 16384 and loaded a 5.5 GB instance. Result: mail briefs
failing for QAPert-NightHawk and DotNetPert-Scout — first a 120 s timeout, then
an HTTP 500 — while the same prompt completed in **12.5 seconds** when nothing
was competing. Prompt size was never the problem.

## Current settings

| caller | file | model | `num_ctx` |
|---|---|---|---|
| mail brief composer | `acp-api/api/mail/briefComposer.ts` | `qwen2.5-coder:7b` | 8192 |
| shutdown summariser | `scripts/shutdown-with-summaries.py` | `qwen2.5-coder:7b` | 8192 |
| model watchdog | `scripts/summariser-watch.sh` | `qwen2.5-coder:7b` | 8192 |
| boot brief | `scripts/brief/bootbrief.sh` | `qwen2.5-coder:7b` | 8192 |
| **spotter** | `scripts/spotter/spot.sh` | **`qwen2.5-coder:1.5b`** | 8192 |
| kb embedder | `.claude/hooks/kb_recall.py`, `kb_remember.py` | `nomic-embed-text` | n/a |

**Why 8192.** The largest prompt this rig can produce is
`MAX_MAILS_SUMMARISED` (25) × `BODY_CHARS` (700) plus headers ≈ **5,700 tokens**.
8192 fits with margin and keeps the 7b instance near 5 GB, leaving headroom for
build bursts.

**Why the spotter is different.** It judges log health, a far lighter job than
summarising mail, and on this card it was competing for the same 7b instance the
composer needs. A 1 GB model coexists instead of evicting. Use the **instruct**
`1.5b`, never `1.5b-base` — base models continue text rather than follow
instructions, and the spotter needs a parseable verdict. Its log already carries
`ALERT: unparseable verdict` lines; a base model makes that permanent.

**Why the watchdog is NOT lighter.** A canary that probes a different model than
the one composing briefs tells you nothing about the model that matters.

## Rules earned the hard way

**A fallback model must fit in VRAM.** `shutdown-with-summaries.py` had
`SUMMARY_FALLBACK_MODEL = "gemma4:26b"` — **17 GB on an 8 GB card**, with a 600 s
timeout, inside a caller (`index.ts` `execSync`) that allows **90 s total for all
seven agents**. It could never complete even in principle, and every attempt
evicted both qwen *and* nomic — which also broke `kb_remember`, because that
needs nomic to embed. Rung 3 now shrinks the *input* on a model already resident.
*A fallback that cannot fit in memory is not a fallback; it is an outage with a
retry's name on it.*

**Retry needs backoff.** `AbortController` stops *us* waiting; it does **not**
stop Ollama generating. A retry fired the instant the client gave up arrives
while the model is still busy and gets a 500 — turning one slow generation into
two failures. 15 s pause before the second attempt.

**Check `ollama list` against `nvidia-smi` before choosing any model.** A model
larger than the card does not degrade gracefully; it takes the working models
down with it.

**`options` only works on Ollama's NATIVE endpoints.** `/v1/chat/completions` is
the OpenAI-compatibility shim and it **silently ignores `options`** — including
`num_ctx`. Sending it there is not an error and returns a normal answer, so the
caller looks compliant while loading the model at its 32768 default. Measured
2026-08-15: `spot.sh` had been posting `options.num_ctx: 8192` to the compat
endpoint and the 1.5b was resident at **ctx 32768, 2.02 GB**; moved to
`/api/chat` it became **ctx 8192, 1.29 GB**, and the card went 7.33 GB → 6.60 GB.
Use `/api/chat` or `/api/generate`; note `num_predict` replaces `max_tokens` and
the answer is at `.message.content`, not `.choices[0].message.content`.
*Verify the rule with `ollama ps`, not by reading the caller's source — the
request looked correct in every file.*

**The same defect in `bootbrief.sh` was far worse, and the spot.sh fix did not
carry to it** (found by the Mac team reviewing `104773a`, 2026-08-15). That
caller runs the **7b**, so one boot brief on the compat endpoint did this:

| | 7b | 1.5b | nomic | total |
|---|---|---|---|---|
| before | ctx 8192, 4.99 GB | 1.29 GB | 0.32 GB | 6.60 GB, 3 models |
| after ONE compat call | **ctx 32768, 6.25 GB** | **evicted** | **evicted** | 6.25 GB, 1 model |
| after the fix | ctx 8192, 5.13 GB | | | |

It did not merely bloat the 7b — it **evicted the spotter's model and the
embedder**. No `nomic-embed-text` means kb recall and every kb write stop until
it reloads. So a single boot brief could blind the monitor and silently stop
memory, and **neither of those failures names a boot brief as its cause.** When
the rig misbehaves in three unrelated-looking ways at once, suspect one caller
that disagreed about context size.

**Never put a comment inside a shell line-continuation.** Same script, same day:
a `#` block was inserted between `curl … \` and its `-d …` line. Backslash-newline
joins the lines, so the `#` commented out the rest of the logical line including
the body. curl issued a bodyless GET, Ollama answered `405 Method Not Allowed`,
and the spotter emitted `ALERT: unparseable verdict: 405 method not allowed`
every five minutes for four hours. *It failed loudly and was still ignored,
because a monitor that cries the same thing on a timer is indistinguishable from
one that is broken.* `bash -n` does not catch this — the script is valid.

## Diagnosing

```bash
ollama ps        # SIZE, PROCESSOR, and CONTEXT per loaded instance
nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader
tail ~/summariser-watch.log
```

Read `ollama ps` carefully — it is the instrument that exposes this class:

- **two rows for the same model** → two context sizes → thrash
- **`CONTEXT` not 8192** → a caller is disagreeing; find it
- **`PROCESSOR` showing any CPU %** → the instance does not fit; it is paging
- **`SIZE` above ~5.5 GB for the 7b** → context is larger than configured

**Absence of `llama-server.exe` in Task Manager is not evidence anything is
down.** Models unload after ~5 minutes idle and reload on demand.

## What is still unexplained

The `@@@@@@@@` degeneracy — the model returning a run of one character instead of
a summary. Measured rate roughly **1 in 56 generations**, always isolated, always
recovering on the next attempt. **Three hypotheses have been tested; two were
falsified** (num_ctx too large; qwen/nomic VRAM contention — both reproduced
deliberately and produced clean output). The third, eviction thrash from
mismatched `num_ctx`, is the reason for the rule above and is the best candidate,
because both earlier tests ran with a *single* caller active — precisely the
condition under which the fault cannot occur.

**It is contained, not cured.** Four layers sit between it and an agent acting on
garbage: the retry, `isDegenerate()`, `stripRepetitionRun()` for a corrupted
tail, and an honest labelled raw-list fallback. If the watchdog stays quiet
through busy periods now that all callers agree, the diagnosis holds. If it does
not, the cause is still something else — **do not claim it fixed a third time
without a measurement that survives repetition.**
