#!/bin/bash
# Watchdog for the two LOCAL models the rig depends on.
#
# WHY IT EXISTS. On 2026-08-14 the mail summariser degenerated and the FIRST
# anyone knew of it was an agent receiving a brief that read "SUMMARISER DOWN -
# raw list, read these yourself". The fallback behaved correctly; the problem is
# that a person downstream was the detector. Jon: "make it so you know when it
# goes down before me."
#
# WHAT IT WATCHES, and why both:
#   qwen2.5-coder:7b   composes every mail brief. Down => agents get raw lists.
#   nomic-embed-text   embeds every prompt for kb recall AND every kb write.
#                      Down => memory silently stops being retrieved, which is
#                      far quieter than a bad brief and therefore worse.
#
# HOW IT REPORTS. It EXITS NON-ZERO on a confirmed failure. That is the whole
# design: an exiting background task raises a notification, so the operator is
# told. A watchdog that only writes to a log is a log nobody is reading at 3am.
#
# It tolerates a single bad probe on purpose. The observed failure was transient
# and its cause is NOT established - two theories (num_ctx too large, VRAM
# contention with the embedder) were tested and both falsified. So one bad roll
# is noise; FAILS_TO_ALERT consecutive bad rolls is a fault.
#
#   ./summariser-watch.sh [interval_seconds]

set -uo pipefail

OLLAMA="${KB_OLLAMA_URL:-http://10.0.0.220:11434}"
GEN_MODEL="${BRIEFR_MODEL:-qwen2.5-coder:7b}"
EMB_MODEL="${KB_EMBED_MODEL:-nomic-embed-text}"
INTERVAL="${1:-120}"
FAILS_TO_ALERT="${FAILS_TO_ALERT:-2}"
LOG="${SUMMARISER_WATCH_LOG:-$HOME/summariser-watch.log}"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
say()   { echo "$(stamp) $*" | tee -a "$LOG"; }

# The SAME judgement briefComposer.isDegenerate() makes, so the watchdog cannot
# pass on output the real consumer would reject. Kept deliberately crude: a
# canary answer is short, so the ratio tests in the TS version would misfire.
is_bad() {
    local text="$1"
    [ -z "$text" ] && return 0                              # empty
    [ "${#text}" -lt 2 ] && return 0                        # nothing usable
    grep -qE '(.)\1{7,}' <<<"$text" && return 0             # repetition run ('@@@@@@@@')
    grep -qi 'healthy' <<<"$text" || return 0               # did not answer the canary
    return 1
}

probe_gen() {
    curl -s --max-time 90 "$OLLAMA/api/generate" \
        -d "{\"model\":\"$GEN_MODEL\",\"prompt\":\"Reply with exactly: HEALTHY\",\"stream\":false,\"options\":{\"num_ctx\":8192,\"temperature\":0.2}}" \
    | python -c "import sys,json;print(json.load(sys.stdin).get('response','').strip())" 2>/dev/null
}

probe_emb() {
    curl -s --max-time 60 "$OLLAMA/api/embeddings" \
        -d "{\"model\":\"$EMB_MODEL\",\"prompt\":\"healthcheck\"}" \
    | python -c "import sys,json;v=json.load(sys.stdin).get('embedding') or [];print(len(v))" 2>/dev/null
}

say "[watch] starting. gen=$GEN_MODEL emb=$EMB_MODEL every ${INTERVAL}s, alert after $FAILS_TO_ALERT consecutive failures"

gen_fails=0
emb_fails=0

while true; do
    # --- generation ---
    out="$(probe_gen)"
    if is_bad "$out"; then
        gen_fails=$((gen_fails + 1))
        say "[watch] GEN probe failed ($gen_fails/$FAILS_TO_ALERT) -> $(printf '%.60s' "${out:-<empty>}")"
        if [ "$gen_fails" -ge "$FAILS_TO_ALERT" ]; then
            say "[watch] ALERT: $GEN_MODEL is producing unusable output on $gen_fails consecutive probes."
            say "[watch] Mail briefs are falling back to raw subject lists RIGHT NOW."
            say "[watch] Last response: ${out:-<empty>}"
            exit 1
        fi
    else
        [ "$gen_fails" -gt 0 ] && say "[watch] GEN recovered after $gen_fails failed probe(s)"
        gen_fails=0
    fi

    # --- embeddings ---
    dims="$(probe_emb)"
    if [ "${dims:-0}" != "768" ]; then
        emb_fails=$((emb_fails + 1))
        say "[watch] EMB probe failed ($emb_fails/$FAILS_TO_ALERT) -> dims=${dims:-none}, expected 768"
        if [ "$emb_fails" -ge "$FAILS_TO_ALERT" ]; then
            say "[watch] ALERT: $EMB_MODEL is not returning 768-dim vectors on $emb_fails consecutive probes."
            say "[watch] kb recall and kb writes are silently degraded - nothing downstream will say so."
            exit 2
        fi
    else
        [ "$emb_fails" -gt 0 ] && say "[watch] EMB recovered after $emb_fails failed probe(s)"
        emb_fails=0
    fi

    sleep "$INTERVAL"
done
