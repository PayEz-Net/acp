# Spotter & Mail Router — Quick Start

Two local-model watchers that keep the rig honest without spending account
tokens. Both judge with **qwen2.5-coder:7b on Ollama**; both do their measuring
in plain code and let the model do only the judging.

| | Spotter | Mail Router (ProjectBriefr) |
|---|---|---|
| Watches | `acp-dev.log` health | every agent's unread inbox |
| Cadence | 300s | 30s |
| Acts by | writing verdicts, self-mailing BAPert on stall | injecting ONE batched brief per agent |
| Lives in | `scripts/spotter/` | `scripts/project-briefer.py` |

---

## The router is load-bearing — read this first

**Per-message mail push to agents is switched OFF** (`acp-api/api/routes/sseStream.ts`,
`recomputeUpstream`). It cost one turn *and one full session-context reload* per
message: ~2.3M tokens a cycle, a week of quota in four hours. See
[a_very_important_hard_lesson_learned_about_ai_rigs.md](../a_very_important_hard_lesson_learned_about_ai_rigs.md).

So the router is not an optimisation sitting beside a working mail path. **It IS
the mail path.** If ProjectBriefr is not running, agents receive no mail at all —
it just accumulates unread. acp-api prints this at every boot:

```
[SSE] agent mail push SUPPRESSED by design — mail reaches agents as batched
briefs via ProjectBriefr. If briefs are not arriving, the router is down.
```

---

## Prerequisites

1. **Ollama up** with `qwen2.5-coder:7b` — `curl http://10.0.0.220:11434/api/tags`
2. **Rig running** — `npm run dev:prod` (tee the console to `acp-dev.log`)
3. **Logged in with a project STARTED** — every mail route calls
   `requireStartedProjectId`. Until then everything 503s with
   `AGENT_ROSTER_UNAVAILABLE`. This is the usual reason a fresh rig looks broken.

```powershell
Set-Location E:\Repos\acp-desktop
npm run dev:prod 2>&1 | Tee-Object -FilePath .\acp-dev.log
```

---

## Run them

```powershell
# Mail router — the mail path. Start it whenever the rig is up.
Set-Location E:\Repos\acp-desktop
python scripts\project-briefer.py

# One sweep and exit, for testing:
python scripts\project-briefer.py --once
```

```powershell
# Spotter — log health watch
& "C:\Program Files\Git\bin\bash.exe" `
    E:/Repos/acp-desktop/scripts/spotter/spotloop.sh E:/Repos/acp-desktop/acp-dev.log 300
```

There is a second, complementary spotter — `spot-project.sh` /
`spotproject-loop.sh` — which polls BAPert's mail, turns and the kanban instead
of the log. A silent team writes no log lines, so a log-only watch cannot see a
team-wide stall. Run it alongside when working unattended.

---

## How the router decides — no idle guessing

The ACP runtime already refuses to interrupt a live turn: `injectMail` returns
`deferred` when the agent is mid-turn. The router therefore never scrapes logs
or times anything to infer "idle" — it offers the brief and reads the answer.

| Response | Meaning | Router's move |
|---|---|---|
| `200 delivered` | landed in a turn | mark those messages read |
| `202 deferred` | agent mid-turn, parked **by design** | keep, re-offer next sweep |
| `404 no-runtime` | no live ACP session for that name | keep, log |
| `502 failed` | runtime unreachable | keep, ALERT |

**Mail is marked read only after `delivered`.** Everything else leaves it unread,
so the server's unread set is the router's memory: restart the router and it
loses nothing and re-briefs nothing.

Batching: a burst is held until `BRIEFR_SETTLE` seconds of quiet, or
`BRIEFR_MAX_HOLD` at the outside. Bursts (agent finishes, mails three people,
they all reply) collapse into one brief; a lone message waits about a minute.

Delivery path: `POST /v1/lifecycle/agents/<name>/inject` → `callElectron` →
`lifecycle-server.ts` `/internal/mail/inject` → `pty.ts injectMailToAgent` →
`AcpRuntimeManager.injectMail`.

---

## Config (env)

| Var | Default | Notes |
|---|---|---|
| `ACP_API_URL` | `http://127.0.0.1:3001` | |
| `KB_OLLAMA_URL` | `http://10.0.0.220:11434` | localhost works too |
| `BRIEFR_MODEL` | `qwen2.5-coder:7b` | |
| `BRIEFR_IDENTITY` | `BAPert` | `X-ACP-Agent` used for API calls |
| `BRIEFR_AGENTS` | *discovered* | comma-separated roster override |
| `BRIEFR_INTERVAL` | `30` | seconds between sweeps |
| `BRIEFR_SETTLE` | `60` | hold a burst until this much quiet |
| `BRIEFR_MAX_HOLD` | `600` | deliver regardless after this |

Spotter verdicts land in `scripts/spotter/spotter-status.log`; alerts also in
`spotter-alert.txt`.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ALERT roster unavailable (HTTP 503)` | not logged in / no project started |
| Router logs `no roster - nothing watched` | same — it refuses to invent a team |
| Agents get no mail, router not running | expected: the router IS the mail path |
| `no live ACP session` | agent not spawned, or PTY-only (inject is ACP-only) |
| `SUMMARISER DOWN - raw list` in a brief | Ollama unreachable; mail still delivered, unsummarised |
| Briefs repeat | mark-read failing — check the ALERT naming the count |
| Spotter always `app down, watch parked` | port 40030 not listening |

---

## Open

- **Session summary can afford to be richer now.** It was cut to ~300 tokens at
  boot as a context-size fix, but the real win turned out to be turn elimination
  (77×), not per-turn size. With briefs collapsing the turn count, a fuller
  summary is affordable — particularly for BAPert, who wants a large context on
  a high-capacity model. Loosen it and measure before cutting again.
