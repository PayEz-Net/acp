#!/usr/bin/env bash
# Loop wrapper for project activity spotter — runs every 5 min
STATE="${1:-E:/Repos/_tmp/spotter}"
INTERVAL="${2:-300}"  # 5 min

mkdir -p "$STATE"
echo "[spotproject-loop] watching BAPert + kanban every ${INTERVAL}s — verdicts in $STATE/project-status.log"

while true; do
  bash "$(dirname "$0")/spot-project.sh" "$STATE"
  sleep "$INTERVAL"
done
