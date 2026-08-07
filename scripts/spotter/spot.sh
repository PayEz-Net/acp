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
if [ "$SIZE" = "$PREV" ]; then
  echo "$(date '+%H:%M') OK: no new output since last check" >> "$STATUS"
  exit 0
fi
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
- ALERT if BAPert (the team lead — his stalls stall the whole project) shows: mail deferred with NO BAPert turn dispatch or settle nearby (his turns are getting lost), a BAPert turn cancelled mid-work (stopReason=cancelled outside an obvious human interrupt), or zero BAPert activity lines while other agents are actively working.
- OK if a BAPert defer or stopReason=cancelled follows a HUMAN prompt to BAPert — the 60s human-reply backstop cancels the busy turn to answer Jon; the nudge then carries his message. That is the designed tradeoff, not a lost turn.
- OK if: turns settling (end_turn), mail delivering, occasional single busy-rejection followed by immediate cancel (that is a designed zombie-cleanup), or quiet with no errors.
- If the log shows the app shutting down (SIGTERM/teardown/Quit), output OK: app stopped.

Recent counters: zombie_cancels=$CANCEL_ZOMBIE busy_resyncs=$BUSY_RESYNC watchdog_fires=$WATCHDOG restarts=$RESTART queue_drops=$DROPS mail_defers=$DEFERS http429=$R429 bapert_defers=$BA_DEFERS bapert_turn_events=$BA_TURNS

BAPert's most recent lines:
$BA_LAST

Recent log lines:
$DIGEST"

RESP=$(curl -s -m 90 http://localhost:11434/v1/chat/completions -H 'Content-Type: application/json' \
  -d "$(python -c "import json,sys; print(json.dumps({'model':'qwen2.5-coder:7b','messages':[{'role':'user','content':sys.stdin.read()}],'max_tokens':120,'temperature':0}))" <<< "$PROMPT")" \
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
