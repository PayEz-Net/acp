---
name: boot-brief
description: Summarize the kanban board + an agent's recent mail into one BOOT BRIEF mail via the local qwen model. Use when the user says 'boot brief', asks for a session-start summary, state of the board, or a standup brief.
trigger: boot brief
---

# Boot Brief — session-start summary via local qwen

Sends ONE mail to BAPert ("BOOT BRIEF — session start") summarizing the kanban
board and his 25 most recent mails: State of the board / Needs Jon / Move first
/ Stranded risk / FYI. Advise-only: no mail is ever withheld, and if the local
model is down NOTHING is sent — silence never reads as "all clear".

## Step 1: Run the script

```bash
bash E:/Repos/acp-desktop/scripts/brief/bootbrief.sh
```

(Optional state dir as arg 1; defaults to `Q:/repos-stuff/_tmp/spotter`.)

The script waits up to 3 min for the platform on `127.0.0.1:3001`, de-dupes
within 30 min, summarizes via local Ollama (qwen2.5-coder:7b), and self-mails
BAPert. It needs nothing but the local API and Ollama.

## Step 2: Report

- Check the log tail: `tail -3 Q:/repos-stuff/_tmp/spotter/bootbrief.log`
- `brief sent (N chars)` → tell the user it's in BAPert's inbox.
- `qwen brief unusable` / `platform never came up` / `skipping` → say exactly
  what the log says and stop. Do not fake a summary yourself.

**Rules:**
1. The script does the work — never hand-write the brief from your own context.
2. Never send mail marked as a boot brief by any other path.
3. One brief per boot; the 30-min de-dupe is deliberate, don't bypass it.
