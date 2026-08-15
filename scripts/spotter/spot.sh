#!/usr/bin/env bash
# ACP spotter — local-model edition (qwen2.5-coder:7b via Ollama).
# Mechanical digest in bash; the model only judges the digest. Cheap by design:
# no LLM call when the log hasn't moved since the last check.
#
# Usage: spot.sh <app-log-path> [state-dir]
# Verdicts append to <state-dir>/spotter-status.log; ALERTs also to spotter-alert.txt.

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

RESP=$(curl -s -m 90 http://localhost:11434/v1/chat/completions -H 'Content-Type: application/json' \
# NUM_CTX MUST MATCH EVERY OTHER CALLER ON THIS BOX (16384).
# Ollama keeps a SEPARATE loaded instance per context size. qwen2.5-coder:7b's
# default is 32768, so a caller that omits num_ctx loads a 6.8GB instance and
# EVICTS the 5.5GB 16384 instance the mail-brief composer uses — which then
# reloads and evicts this one back. On an 8GB card the two thrash, and requests
# issued during a swap come back as a timeout or a bare HTTP 500. Measured
# 2026-08-15: brief failures for two agents began the minute this script was
# restarted. If you change this number, change it in briefComposer.ts and
# shutdown-with-summaries.py in the same commit.
  -d "$(python -c "import json,sys; print(json.dumps({'model':'qwen2.5-coder:7b','messages':[{'role':'user','content':sys.stdin.read()}],'options':{'num_ctx':16384},'max_tokens':120,'temperature':0}))" <<< "$PROMPT")" \
  | python -c "import json,sys; print(json.load(sys.stdin)['choices'][0]['message']['content'].strip().splitlines()[0].strip())" 2>/dev/null)

[ -n "${RESP:-}" ] || RESP="ALERT: local model call failed — spotter is blind"
case "$RESP" in
  ALERT:*) ;;
  OK:*) ;;
  OK) RESP="OK: quiet" ;;
  *) RESP="ALERT: unparseable verdict: ${RESP:0:100}" ;;
esac

echo "$(date '+%H:%M') $RESP" >> "$STATUS"
case "$RESP" in ALERT:*) echo "$(date '+%F %H:%M') $RESP" >> "$ALERTS";; esac
