#!/usr/bin/env bash
# Project activity spotter — watches BAPert + kanban for real work movement.
# Usage: spot-project.sh [state-dir]
# Verdicts append to <state-dir>/project-status.log

set -u
STATE="${1:-E:/Repos/_tmp/spotter}"
mkdir -p "$STATE"
STATUS="$STATE/project-status.log"
LASTMAIL="$STATE/last-mail-timestamp"
LASTKANBAN="$STATE/last-kanban-update"
LASTBAPERT="$STATE/last-bapert-turn"
QUIET="$STATE/quiet-count.txt"

API="http://127.0.0.1:3001"

# --- Check BAPert's latest mail ---
MAIL=$(curl -s -m 5 "$API/v1/mail/messages?to=BAPert&limit=1" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',[{}])[0].get('created_at','') or d.get('data',[{}])[0].get('timestamp',''))" 2>/dev/null || echo "")
PREV_MAIL=$(cat "$LASTMAIL" 2>/dev/null || echo "0")
if [ "$MAIL" != "$PREV_MAIL" ] && [ -n "$MAIL" ]; then
  echo "$MAIL" > "$LASTMAIL"
  echo 0 > "$QUIET"
  echo "$(date '+%H:%M') ACTIVITY: BAPert inbox moved — new mail at $MAIL" >> "$STATUS"
  exit 0
fi

# --- Check BAPert's latest turn in the log ---
LOG="${E_REPOS_ALOG:-E:/Repos/acp-desktop/acp-dev.log}"
if [ -f "$LOG" ]; then
  LASTLINE=$(tail -100 "$LOG" | grep '\[ACP BAPert\]' | tail -1)
  if echo "$LASTLINE" | grep -qE '>>> session/prompt|<<< result'; then
    # Extract timestamp if available (varies by log format)
    BAPERT_TIME=$(echo "$LASTLINE" | grep -oE '[0-9]{2}:[0-9]{2}' | tail -1)
    PREV_BAPERT=$(cat "$LASTBAPERT" 2>/dev/null || echo "")
    if [ "$BAPERT_TIME" != "$PREV_BAPERT" ] && [ -n "$BAPERT_TIME" ]; then
      echo "$BAPERT_TIME" > "$LASTBAPERT"
      echo 0 > "$QUIET"
      echo "$(date '+%H:%M') ACTIVITY: BAPert turn — $BAPERT_TIME" >> "$STATUS"
      exit 0
    fi
  fi
fi

# --- Check kanban for recent task updates ---
KANBAN=$(curl -s -m 5 "$API/v1/kanban/tasks?limit=5" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); tasks=d.get('data',[]); print(max((t.get('updated_at') or t.get('created_at') or '') for t in tasks) if tasks else '')" 2>/dev/null || echo "")
PREV_KANBAN=$(cat "$LASTKANBAN" 2>/dev/null || echo "0")
if [ "$KANBAN" != "$PREV_KANBAN" ] && [ -n "$KANBAN" ]; then
  echo "$KANBAN" > "$LASTKANBAN"
  echo 0 > "$QUIET"
  echo "$(date '+%H:%M') ACTIVITY: kanban updated — $KANBAN" >> "$STATUS"
  exit 0
fi

# --- No activity detected — increment quiet counter ---
QUIET_COUNT=$(( $(cat "$QUIET" 2>/dev/null || echo 0) + 1 ))
echo "$QUIET_COUNT" > "$QUIET"

if [ "$QUIET_COUNT" -ge 3 ]; then
  echo "$(date '+%H:%M') ALERT: BAPert idle for $((QUIET_COUNT * 5))+ min (no mail, turns, or kanban changes)" >> "$STATUS"
  echo "$(date '+%F %H:%M') ALERT: BAPert idle for $((QUIET_COUNT * 5))+ min" >> "$STATE/project-alert.txt"

  # Nudge if this is the first alert of this episode
  if [ "$QUIET_COUNT" -eq 3 ]; then
    NUDGE=$(curl -s -m 10 -X POST "$API/v1/mail/send" \
      -H "Content-Type: application/json" -H "X-ACP-Agent: BAPert" \
      -d '{"from_agent":"BAPert","to":["BAPert"],"subject":"IDLE: project stalled 15+ min","body":"No mail, agent turns, or kanban changes for 15+ minutes. Check the board and move the next card.","priority":"high"}' 2>/dev/null)
    if echo "$NUDGE" | grep -q '"success":true'; then
      echo "$(date '+%H:%M') nudged BAPert" >> "$STATUS"
    fi
  fi
else
  echo "$(date '+%H:%M') OK: quiet $QUIET_COUNT/3" >> "$STATUS"
fi
