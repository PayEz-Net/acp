#!/usr/bin/env bash
# Spotter loop — runs spot.sh on a cadence. Local model only (Ollama qwen2.5-coder:7b),
# zero kimi-account tokens. Lives only as long as the hosting kimi session.
#
# Usage: spotloop.sh <app-log-path> [interval-seconds] [state-dir]
#   default interval: 300; default state-dir: alongside this script.
set -u
LOG="${1:?usage: spotloop.sh <app-log-path> [interval-seconds] [state-dir]}"
INTERVAL="${2:-300}"
DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="${3:-$DIR}"
echo "[spotloop] watching $LOG every ${INTERVAL}s — verdicts in $STATE/spotter-status.log"
while true; do
  bash "$DIR/spot.sh" "$LOG" "$STATE"
  sleep "$INTERVAL"
done
