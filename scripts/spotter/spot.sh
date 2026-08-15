#!/usr/bin/env bash
# ACP spotter — local-model edition (light model via Ollama; see SPOT_MODEL).
# Mechanical digest in bash; the model only judges the digest. Cheap by design:
# no LLM call when the log hasn't moved since the last check.
#
# Usage: spot.sh <app-log-path> [state-dir]
# Verdicts append to <state-dir>/spotter-status.log; ALERTs also to spotter-alert.txt.

# MODEL: the spotter runs a LIGHT model on purpose (qwen2.5-coder:1.5b, ~1GB).
# Its job is judging log health, not summarising mail — and on an 8GB card it
# was competing for the same 7b instance the mail-brief composer needs. Two
# callers, one card, and the loser gets a timeout or a bare HTTP 500 (measured
# 2026-08-15: brief failures for two agents began when this script restarted).
# A separate 1GB model coexists with the 7b instead of evicting it.
#
# NOT the `1.5b-base` variant that was already on the box: base models continue
# text rather than follow instructions, and this script needs a parseable
# verdict. Its log already carries "ALERT: unparseable verdict" lines; a base
# model would make that permanent.
SPOT_MODEL="${SPOT_MODEL:-qwen2.5-coder:1.5b}"

set -u
LOG="${1:?usage: spot.sh <app-log-path> [state-dir]}"
STATE="${2:-E:/Repos/_tmp/spotter}"
mkdir -p "$STATE"
STATUS="$STATE/spotter-status.log"
ALERTS="$STATE/spotter-alert.txt"
LASTRUN="$STATE/last-size.txt"

[ -f "$LOG" ] || { echo "$(date '+%H:%M') NO-LOG: $LOG missing" >> "$STATUS"; exit 0; }

SIZE=$(stat -c '%s' "$LOG")
PREV=$(cat "$LASTRUN" 2>/dev/null || echo 0)

# ROTATION DETECTION. This tracks progress by BYTE COUNT against a fixed path,
# so a rotated log (mv acp-dev.log acp-dev.prev-X.log; new file at the same
# path) silently breaks it: the new file starts at 0 while $PREV holds the old
# file's size. Two failure modes, both quiet —
#   new file SMALLER than PREV  -> SIZE-PREV is NEGATIVE, `tail -c -N` errors,
#                                  NEWBYTES is empty, and every cycle is scored
#                                  "quiet" no matter how much the rig logs. The
#                                  spotter reports OK while blind.
#   new file LARGER than PREV   -> only the difference is read, so the whole
#                                  head of the new log is never examined.
# Measured 2026-08-15: acp-dev.log rotated twice during a restart; tracked size
# 10815 against a live file of 10985, i.e. the spotter judged the rig on a
# 170-byte tail of a file it had never seen the start of.
# A shrink cannot happen by appending, so it is unambiguous: treat it as a new
# file and read from the beginning.
if [ "$SIZE" -lt "$PREV" ]; then
  echo "$(date '+%H:%M') NOTE: log rotated or truncated (${PREV} -> ${SIZE} bytes) — resetting to read from start" >> "$STATUS"
  PREV=0
fi

# Noise lines (available_commands_update / usage_update floods) keep the byte
# count moving while nothing real happens — treat growth that is ONLY noise as
# quiet, else the idle detector never fires (Jon 2026-08-13).
NEWBYTES=""
[ "$SIZE" != "$PREV" ] && NEWBYTES=$(tail -c $((SIZE - PREV)) "$LOG" 2>/dev/null | grep -vE 'notification: (available_commands_update|usage_update)' | grep -v '^$' || true)
if [ "$SIZE" = "$PREV" ] || [ -z "$NEWBYTES" ]; then
  echo "$SIZE" > "$LASTRUN"
  QUIET=$(( $(cat "$STATE/quiet-count.txt" 2>/dev/null || echo 0) + 1 ))
  echo "$QUIET" > "$STATE/quiet-count.txt"
  if [ "$QUIET" -ge 3 ]; then
    # App still listening but nothing moving = the team went idle (Jon's main
    # ask: know when BAPert/project stalls). App down = just park.
    if netstat -ano | grep -qE ':40030 .*LISTENING'; then
      echo "$(date '+%H:%M') ALERT: project idle — no agent output for $((QUIET * 5))+ min while the app is up" >> "$STATUS"
      echo "$(date '+%F %H:%M') ALERT: project idle — no agent output for $((QUIET * 5))+ min while the app is up" >> "$ALERTS"
      # Jon: "if I'm not around, mail BAPert and nudge him along." One self-mail
      # per idle episode; the flag clears when output resumes.
      if [ ! -f "$STATE/idle-nudged.flag" ]; then
        NUDGE=$(curl -s -m 10 -X POST "http://127.0.0.1:3001/v1/mail/send" \
          -H "Content-Type: application/json" -H "X-ACP-Agent: BAPert" \
          -d '{"from_agent":"BAPert","to":["BAPert"],"subject":"SPOTTER NUDGE: project idle 15+ min","body":"No agent output for 15+ minutes while the app is up (local spotter noticing, Jon away). Check the board, deal the next card, and get the lanes moving.","priority":"high"}' 2>/dev/null)
        if echo "$NUDGE" | grep -q '"success":true'; then
          echo "$(date '+%H:%M') nudged BAPert via self-mail (idle episode)" >> "$STATUS"
          touch "$STATE/idle-nudged.flag"
        else
          echo "$(date '+%H:%M') ALERT: nudge mail FAILED: $(echo "$NUDGE" | head -c 120)" >> "$STATUS"
          echo "$(date '+%F %H:%M') ALERT: nudge mail FAILED: $(echo "$NUDGE" | head -c 120)" >> "$ALERTS"
        fi
      fi
    else
      echo "$(date '+%H:%M') OK: app down, watch parked" >> "$STATUS"
    fi
  else
    echo "$(date '+%H:%M') OK: no new output since last check" >> "$STATUS"
  fi
  exit 0
fi
rm -f "$STATE/idle-nudged.flag"
echo 0 > "$STATE/quiet-count.txt"
echo "$SIZE" > "$LASTRUN"

# --- mechanical digest (last 300 lines, tool-call noise removed) ---
DIGEST=$(tail -300 "$LOG" | grep -vE 'notification: (tool_call|plan)' | tail -120)
CANCEL_ZOMBIE=$(echo "$DIGEST" | grep -c 'first dispatch after spawn busy-rejected' || true)
BUSY_RESYNC=$(echo "$DIGEST" | grep -c 're-queueing prompt and re-syncing' || true)
WATCHDOG=$(echo "$DIGEST" | grep -cE 'no response for|sent session/cancel' || true)
RESTART=$(echo "$DIGEST" | grep -c 'restarting runtime' || true)
DROPS=$(echo "$DIGEST" | grep -c 'dropping .* queued' || true)
DEFERS=$(echo "$DIGEST" | grep -c 'mail deferred' || true)
R429=$(echo "$DIGEST" | grep -c 'HTTP 429' || true)
LASTLINE=$(echo "$DIGEST" | tail -3)
# BAPert is the lynchpin (Jon 2026-08-07): his defers and silence get their own
# counters so the model doesn't have to fish for them.
BA_DEFERS=$(tail -300 "$LOG" | grep -c '\[ACP BAPert\] mail deferred' || true)
BA_TURNS=$(echo "$DIGEST" | grep -cE '\[ACP BAPert\] (>>>|<<<)' || true)
BA_LAST=$(tail -400 "$LOG" | grep '\[ACP BAPert\]' | grep -vE 'notification: (tool_call|plan)' | tail -3)

PROMPT="You are a log-triage classifier for an agent platform. Output EXACTLY one line, starting with OK: or ALERT:.

Rules:
- ALERT if: restarts happening repeatedly, watchdog cancels firing repeatedly, an error repeating in a loop, or mail deferring while agents appear idle (queued mail not draining).
- ALERT if BAPert (the team lead — his stalls stall the whole project) shows: bapert_defers > 0 AND bapert_turn_events == 0 (defers with NO turn activity at all in the window — his turns are getting lost), or a BAPert turn cancelled mid-work (stopReason=cancelled with no human prompt to BAPert nearby). A defer WITH turn events in the window is just a busy agent — the re-drive lands at turn end; do NOT alert on defer-then-later-delivery timing.
- OK if a BAPert defer or stopReason=cancelled follows a HUMAN prompt to BAPert — the 60s human-reply backstop cancels the busy turn to answer Jon; the nudge then carries his message. That is the designed tradeoff, not a lost turn.
- OK if: turns settling (end_turn), mail delivering, occasional single busy-rejection followed by immediate cancel (that is a designed zombie-cleanup), or quiet with no errors.
- If the log shows the app shutting down (SIGTERM/teardown/Quit), output OK: app stopped.

Recent counters: zombie_cancels=$CANCEL_ZOMBIE busy_resyncs=$BUSY_RESYNC watchdog_fires=$WATCHDOG restarts=$RESTART queue_drops=$DROPS mail_defers=$DEFERS http429=$R429 bapert_defers=$BA_DEFERS bapert_turn_events=$BA_TURNS

BAPert's most recent lines:
$BA_LAST

Recent log lines:
$DIGEST"

# NUM_CTX MUST MATCH EVERY OTHER CALLER ON THIS BOX (8192).
# Ollama keeps a SEPARATE loaded instance per context size. qwen2.5-coder:7b's
# default is 32768, so a caller that omits num_ctx loads a 6.8GB instance and
# EVICTS the instance the mail-brief composer uses — which then reloads and
# evicts this one back. On an 8GB card the two thrash, and requests issued
# during a swap come back as a timeout or a bare HTTP 500. Measured
# 2026-08-15: brief failures for two agents began the minute this script was
# restarted. If you change this number, change it in briefComposer.ts and
# shutdown-with-summaries.py in the same commit.
#
# KEEP THIS COMMENT ABOVE THE ASSIGNMENT, NOT INSIDE THE curl CONTINUATION.
# It used to sit between `curl ... \` and `-d ...`. A backslash-newline joins
# the next line onto the command, so a `#` line there comments out the REST of
# the logical line — including the -d body. curl then issued a bodyless GET,
# Ollama answered 405 Method Not Allowed, and every verdict for four hours read
# "ALERT: unparseable verdict: 405 method not allowed". The spotter was blind
# and its alarm was indistinguishable from noise. Do not put a comment inside a
# line-continuation.
#
# NATIVE /api/chat, NOT THE OPENAI-COMPAT /v1/chat/completions. The compat
# endpoint silently IGNORES Ollama's native `options`, so num_ctx never applied
# and this model loaded at its 32768 default — measured 2026-08-15: 2.02GB
# instead of ~1GB, with the card already at 7.33GB of 8GB. The rule in
# docs/LOCAL-MODEL-TUNING.md was being violated by the one caller whose job is
# noticing trouble. `options` is honoured here; `num_predict` replaces
# `max_tokens`, and the answer is at .message.content, not .choices[0].
# HOST IS CONFIGURABLE, and the default is the LAN address, not localhost.
# 10.0.0.220 IS the Windows rig — so on that box localhost and 10.0.0.220 are
# the same Ollama. On any OTHER machine sharing this rig (the Mac team has no
# local Ollama) `localhost` resolves to a box with no model and the spotter
# goes permanently blind, reporting the same failure every cycle. Same env var
# as every other caller (KB_OLLAMA_URL) so one setting moves the whole rig.
#
# Sharing one card across two machines is SAFE PRECISELY BECAUSE of the
# num_ctx rule above: same context size means the same loaded instance, so a
# second rig QUEUES against it rather than loading its own and evicting ours.
OLLAMA="${KB_OLLAMA_URL:-http://10.0.0.220:11434}"
RESP=$(curl -s -m 90 "$OLLAMA/api/chat" -H 'Content-Type: application/json' \
  -d "$(python -c "import json,sys; print(json.dumps({'model':'$SPOT_MODEL','messages':[{'role':'user','content':sys.stdin.read()}],'stream':False,'options':{'num_ctx':8192,'num_predict':120,'temperature':0}}))" <<< "$PROMPT")" \
  | python -c "import json,sys; print(json.load(sys.stdin)['message']['content'].strip().splitlines()[0].strip())" 2>/dev/null)

[ -n "${RESP:-}" ] || RESP="ALERT: local model call failed — spotter is blind"
case "$RESP" in
  ALERT:*) ;;
  OK:*) ;;
  OK) RESP="OK: quiet" ;;
  *) RESP="ALERT: unparseable verdict: ${RESP:0:100}" ;;
esac

echo "$(date '+%H:%M') $RESP" >> "$STATUS"
case "$RESP" in ALERT:*) echo "$(date '+%F %H:%M') $RESP" >> "$ALERTS";; esac
