#!/usr/bin/env bash
# ACP boot brief — local qwen summarizes the board + BAPert's recent mail into
# ONE "state of play" mail to BAPert at rig start.
#
# Design rule (Jon 2026-08-14): ADVISE, NEVER WITHHOLD. All mail still flows to
# BAPert normally; this adds a digest on top. If qwen is down or the summary is
# empty, NOTHING is sent — a failed brief must never look like "all clear".
#
# The summarizer replaces the old mechanical grep-bucketing: qwen reads the
# actual subjects/bodies and writes the brief. Bash only fetches and shapes the
# corpus.
#
# Usage: bootbrief.sh [state-dir]     (run once, right after the rig is up)
# Env:   ACP_API (default http://127.0.0.1:3001), OLLAMA (default localhost:11434)

set -u
STATE="${1:-Q:/repos-stuff/_tmp/spotter}"
mkdir -p "$STATE"
LOGF="$STATE/bootbrief.log"
ACP_API="${ACP_API:-http://127.0.0.1:3001}"
OLLAMA="${OLLAMA:-http://localhost:11434}"
MODEL="${BOOTBRIEF_MODEL:-qwen2.5-coder:7b}"

log() { echo "$(date '+%F %H:%M') $*" >> "$LOGF"; }

# --- wait for the platform (up to 3 min; boot takes a moment) ---
for _ in $(seq 1 18); do
  curl -s -m 3 -o /dev/null "$ACP_API/v1/kanban/tasks" -H "X-ACP-Agent: BAPert" && break
  sleep 10
done
curl -s -m 3 -o /dev/null "$ACP_API/v1/kanban/tasks" -H "X-ACP-Agent: BAPert" || { log "platform never came up; no brief"; exit 0; }

# --- de-dupe: skip if a BOOT BRIEF went out in the last 30 min (rapid restarts) ---
RECENT=$(curl -s -m 10 "$ACP_API/v1/mail/inbox/BAPert?limit=10" -H "X-ACP-Agent: BAPert" | python -c "
import json,sys,datetime
try: msgs=json.load(sys.stdin)['data']['messages']
except Exception: sys.exit(0)
now=datetime.datetime.now(datetime.timezone.utc)
for m in msgs:
    if m['subject'].startswith('BOOT BRIEF'):
        try: t=datetime.datetime.fromisoformat(m['created_at'].replace('Z','+00:00'))
        except Exception: continue
        if (now-t).total_seconds() < 1800: print('dup'); break
" 2>/dev/null)
[ "$RECENT" = "dup" ] && { log "brief already sent <30 min ago; skipping"; exit 0; }

# --- fetch corpus ---
curl -s -m 15 "$ACP_API/v1/kanban/tasks" -H "X-ACP-Agent: BAPert" -o "$STATE/bb-board.json" || { log "kanban fetch failed"; exit 0; }
curl -s -m 15 "$ACP_API/v1/mail/inbox/BAPert?limit=25" -H "X-ACP-Agent: BAPert" -o "$STATE/bb-inbox.json" || { log "inbox fetch failed"; exit 0; }

CORPUS=$(python -c "
import json
from collections import Counter
board=json.load(open(r'$STATE/bb-board.json'))['data']
mail=json.load(open(r'$STATE/bb-inbox.json'))['data']['messages']
c=Counter(t['status'] for t in board)
lines=[f\"BOARD: {dict(c)}\"]
for st in ['blocked','review','in_progress']:
    rows=[t for t in board if t['status']==st]
    lines.append(f'--- {st.upper()} ({len(rows)}) ---')
    for t in rows[:15]:
        lines.append(f\"  #{t['id']} [{(t.get('assignedTo') or '-')}]: {t['title'][:110]}\")
lines.append(f'--- BAPERT INBOX, newest {len(mail)} ---')
for m in mail:
    body=(m.get('body') or '')[:160].replace(chr(10),' ')
    lines.append(f\"  [{m['created_at'][5:16]}] {m['from_agent']}: {m['subject'][:110]} :: {body}\")
print(chr(10).join(lines))
" 2>/dev/null)
[ -n "$CORPUS" ] || { log "empty corpus"; exit 0; }

PROMPT="You are writing a boot brief for BAPert, the business-analyst lead of an AI dev team, at the start of a work session. Be concrete and terse — he acts on named cards, not vibes.

Output EXACTLY these five sections, in this order, markdown, no preamble:
## State of the board
(2-3 sentences: what the counts mean right now, where the mass is)
## Needs Jon
(cards/mails blocked on the human specifically — id + one line each)
## Move first
(the 3-5 highest-value actions for BAPert's first turns — card ids + why, favor: QA-approved cards sitting in review, BLOCKED reports from teammates, anything marked Jon-gated that is actually decided)
## Stranded risk
(work reported GREEN/done/approved in mail but whose card is NOT done — merge/push/deploy gaps; id + what is missing)
## FYI
(one line each, max 5, everything else worth knowing)

Rules: use only the corpus below; cite card/message ids; if a section has nothing, write '- none'. Never invent state.

CORPUS:
$CORPUS"

RESP=$(curl -s -m 120 "$OLLAMA/v1/chat/completions" -H 'Content-Type: application/json' \
  -d "$(python -c "import json,sys; print(json.dumps({'model':'$MODEL','messages':[{'role':'user','content':sys.stdin.read()}],'options':{'num_ctx':8192},'max_tokens':700,'temperature':0}))" <<< "$PROMPT")" \
  | python -c "import json,sys; print(json.load(sys.stdin)['choices'][0]['message']['content'].strip())" 2>/dev/null)

# Guard: no model, empty answer, or missing sections => send NOTHING.
if [ -z "${RESP:-}" ] || ! grep -q '## Move first' <<< "$RESP"; then
  log "qwen brief unusable (model down or malformed); nothing sent"
  exit 0
fi

BODY=$(RESP="$RESP" python -c "
import json,os
print(json.dumps({'from_agent':'BAPert','to':['BAPert'],'subject':'BOOT BRIEF — session start','body':os.environ['RESP'],'body_format':'markdown','priority':'high'}))
")

OUT=$(curl -s -m 10 -X POST "$ACP_API/v1/mail/send" -H 'Content-Type: application/json' -H 'X-ACP-Agent: BAPert' -d "$BODY")
if grep -q '\"success\":true' <<< "$OUT"; then
  log "brief sent ($(wc -c <<< "$RESP") chars)"
else
  log "brief send FAILED: $(head -c 120 <<< "$OUT")"
fi
