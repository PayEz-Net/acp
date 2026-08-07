#!/usr/bin/env bash
# Spotter loop — runs spot.sh on a cadence. Local model only (Ollama qwen2.5-coder:7b),
# zero kimi-account tokens. Lives only as long as the hosting kimi session.
#
# Usage: spotloop.sh <app-log-path> [interval-seconds]   (default interval: 300)
set -u
LOG="${1:?usage: spotloop.sh <app-log-path> [interval-seconds]}"
INTERVAL="${2:-300}"
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "[spotloop] watching $LOG every ${INTERVAL}s — verdicts in $DIR/spotter-status.log"
while true; do
  bash "$DIR/spot.sh" "$LOG" "$DIR"
  sleep "$INTERVAL"
done
