#!/usr/bin/env python3
"""
ProjectBriefr - the agent mail router.

WHY THIS EXISTS
---------------
Seven agents mailing each other cost one turn PER MESSAGE, and every turn
reloads the agent's whole session context. Measured: ~2.3M tokens per heavy
cycle, one week of quota in four hours. See
docs/a_very_important_hard_lesson_learned_about_ai_rigs.md.

The fix is not smaller prompts. It is FEWER TURNS. A human developer does not
stop coding for each arriving email; they finish the thought and read the lot
at a natural breakpoint. This router does that for the rig: hold an agent's
mail while it works, then hand over ONE summarised brief.

WHAT THIS IS NOW. A scheduler, not a summariser. It decides WHEN an agent
should be interrupted; acp-api decides WHAT the brief says. The summariser moved
to api/mail/briefComposer.ts once it gained a second caller — the agent's own
on-demand pull (POST /v1/mail/brief/:agent) — because two summarisers drift and
the drifted one is the one nobody is watching.

HOW IT WORKS
------------
    poll     GET  /v1/mail/inboxes?agents=..&unread=true   (one call per sweep)
    hold     batch per agent until it is worth a turn
    compose  POST /v1/mail/brief/<name>   {mark_read:false}   (server summarises)
    give     POST /v1/lifecycle/agents/<name>/inject
    confirm  POST /v1/mail/brief/<name>/confirm  (only after 'delivered')

IDLE IS NOT GUESSED. The ACP runtime already refuses to interrupt a live turn:
injectMail returns 'deferred' when the agent is mid-turn. So the router simply
offers the brief and reads the answer. That tri-state survives the whole hop:

    200 delivered  -> landed in a turn. NOW mark those messages read.
    202 deferred   -> agent is mid-turn, parked by design. Keep it, re-offer.
    404 no-runtime -> no live ACP session for that name.
    502 failed     -> runtime unreachable. Loud.

Mail is marked read ONLY after 'delivered'. Anything else leaves it unread, so
the next sweep re-offers it. Nothing is ever binned undelivered - the server's
unread set is the router's memory, which means restarting the router loses
nothing and re-briefs nothing.

USAGE
-----
    python project-briefer.py            # run the loop
    python project-briefer.py --once     # one sweep, then exit (for testing)

CONFIG (env)
------------
    ACP_API_URL         default http://127.0.0.1:3001
    (KB_OLLAMA_URL / BRIEFR_MODEL are read by acp-api, not here — the
     summariser owns its own settings.)
    BRIEFR_IDENTITY     X-ACP-Agent identity used for API calls (default BAPert)
    BRIEFR_AGENTS       comma-separated roster override; else discovered
    BRIEFR_INTERVAL     seconds between sweeps (default 30)
    BRIEFR_SETTLE       hold a burst until this many seconds of quiet (default 60)
    BRIEFR_MAX_HOLD     deliver regardless after this long (default 600)
    BRIEFR_BATCH_MAX    deliver as soon as this many are held (default 8)
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ACP_API = os.environ.get("ACP_API_URL", "http://127.0.0.1:3001").rstrip("/")
IDENTITY = os.environ.get("BRIEFR_IDENTITY", "BAPert")

INTERVAL = int(os.environ.get("BRIEFR_INTERVAL", "30"))
SETTLE = int(os.environ.get("BRIEFR_SETTLE", "60"))
MAX_HOLD = int(os.environ.get("BRIEFR_MAX_HOLD", "600"))
# Deliver as soon as this many are held, whatever the settle window is doing.
BATCH_MAX = int(os.environ.get("BRIEFR_BATCH_MAX", "8"))

# Summariser settings (model, ollama url, body caps) now live with the
# summariser, in acp-api/api/mail/briefComposer.ts. They are deliberately NOT
# duplicated here — a second set of knobs is a second behaviour waiting to
# diverge from the one the pull path uses.


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def api(path: str, method: str = "GET", body: dict | None = None, timeout: int = 20):
    """One ACP API call. Returns (status, parsed-json-or-None). Never raises for
    HTTP status - the status IS the answer for the inject route."""
    url = f"{ACP_API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-ACP-Agent", IDENTITY)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw or "null")
        except json.JSONDecodeError:
            return e.code, {"error": {"message": raw[:200]}}


def discover_roster() -> list[str]:
    """Who to watch. Explicit override wins; otherwise ask the server.

    No hardcoded team. A roster this router invented would quietly watch the
    wrong agents and report healthy while a real one sat unbriefed.
    """
    override = os.environ.get("BRIEFR_AGENTS", "").strip()
    if override:
        return [a.strip() for a in override.split(",") if a.strip()]

    status, payload = api("/v1/mail/agents")
    if status != 200 or not isinstance(payload, dict) or not payload.get("success"):
        msg = (payload or {}).get("message") or (payload or {}).get("error")
        log(f"ALERT roster unavailable (HTTP {status}): {str(msg)[:160]}")
        return []

    data = payload.get("data")
    rows = data.get("agents") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        log(f"ALERT roster shape unrecognised: {str(data)[:160]}")
        return []

    names = []
    for row in rows:
        if isinstance(row, str):
            names.append(row)
        elif isinstance(row, dict):
            name = row.get("name") or row.get("agent_name") or row.get("agent")
            if name:
                names.append(str(name))
    if not names:
        log(f"ALERT roster returned {len(rows)} rows but no usable names")
    return names


def fetch_unread(agents: list[str]) -> dict[str, list[dict]]:
    """One request for the whole team (the sidecar fans out with bounded
    concurrency). Per-agent errors are reported, never folded into 'no mail' -
    an inbox that failed to read is not an empty inbox."""
    qs = ",".join(urllib.parse.quote(a) for a in agents)
    status, payload = api(f"/v1/mail/inboxes?agents={qs}&unread=true")
    if status != 200 or not isinstance(payload, dict) or not payload.get("success"):
        msg = (payload or {}).get("message") or (payload or {}).get("error")
        log(f"ALERT inbox poll failed (HTTP {status}): {str(msg)[:160]}")
        return {}

    inboxes = (payload.get("data") or {}).get("inboxes") or {}
    out: dict[str, list[dict]] = {}
    for agent, box in inboxes.items():
        if not isinstance(box, dict):
            continue
        if box.get("error"):
            err = box["error"]
            log(f"ALERT {agent} inbox unreadable: {err.get('code')} {err.get('message', '')[:100]}")
            continue
        # The read flag on the wire is `read_at` (null = unread). The old filter
        # tested `is_read`, a field that does not exist on this payload — so it
        # matched nothing and let everything through. Harmless only because the
        # server is already filtering on `unread=true`; a client-side guard that
        # can never fire is not a guard.
        msgs = [m for m in (box.get("messages") or []) if not m.get("read_at")]
        out[agent] = msgs
    return out



def sanitise_brief(text, agent: str):
    """Last line of defence before text is typed into a terminal.

    THE BUG THIS EXISTS FOR (2026-08-14, live): a brief reached BAPert whose
    body was a perfectly good action list followed by a ~31-character run of
    '@'. The server-side degeneracy gate missed it because that gate measures
    GLOBAL statistics — alnum ratio and max single-character frequency across
    the whole string. One local garbage run inside 600 characters of real text
    is ~5% of the body: nowhere near any global threshold. The gate was built
    for wholesale collapse and is blind to a corrupted TAIL.

    This is also, near-certainly, the "random characters flooding the terminal"
    from earlier: a repetition run typed into a pane. I had concluded that was a
    rendering artifact after sampling each agent's most recent brief and finding
    them clean — I sampled the wrong ones.

    So: cut at the first long repetition run and keep what came before it. The
    good half of a brief is worth delivering; the run is worth neither showing
    an agent nor typing into a TUI. Say plainly that it was cut, because an
    agent acting on a silently truncated list would not know what it missed.
    """
    if not text:
        return text
    # 8+ of the same character in a row is never prose, never markdown, and
    # never a legitimate separator we emit.
    m = re.search(r"(.)\1{7,}", text)
    if not m:
        return text
    head = text[:m.start()].rstrip()
    log(
        f"ALERT {agent}: brief contained a {len(m.group(0))}-char repetition run "
        f"of {m.group(1)!r} at offset {m.start()} — truncated"
    )
    if len(head) < 120:
        # Almost nothing survived; a stub brief is worse than none.
        log(f"ALERT {agent}: brief unusable after truncation — holding mail for the next sweep")
        return None
    return head + "\n\n[brief truncated: the summariser emitted a repetition run. Read your unread mail directly if this looks incomplete.]"


class Held:
    """What we are holding for one agent, and since when."""

    __slots__ = ("mails", "first_seen", "last_change")

    def __init__(self):
        self.mails: dict = {}
        self.first_seen = 0.0
        self.last_change = 0.0


def sweep(state: dict[str, Held], agents: list[str]) -> None:
    unread = fetch_unread(agents)
    now = time.time()

    for agent, mails in unread.items():
        held = state.setdefault(agent, Held())
        ids = {m.get("message_id") for m in mails if m.get("message_id") is not None}
        known = set(held.mails)

        if not ids:
            if known:
                # Read elsewhere (a human, or the agent itself). Stop holding.
                log(f"{agent}: {len(known)} held message(s) cleared upstream")
                state[agent] = Held()
            continue

        fresh = ids - known
        held.mails = {m["message_id"]: m for m in mails if m.get("message_id") is not None}
        if fresh:
            if not known:
                held.first_seen = now
            held.last_change = now
            log(f"{agent}: +{len(fresh)} mail (holding {len(held.mails)})")

        quiet_for = now - held.last_change
        holding_for = now - held.first_seen
        # Deliver when the burst has settled, when the batch is already big
        # enough to be worth a turn, or when holding has gone on long enough
        # that waiting for quiet is just a delay.
        #
        # BATCH_MAX exists because quiet-only starves the busiest agent: every
        # arrival restarts the settle window, so the agent receiving the most
        # mail is briefed LAST. Measured 2026-08-14 — DotNetPert took +6/+2/+1/+3
        # across four sweeps, never saw 60s of quiet, and sat on 12 held messages
        # waiting for the 10-minute backstop while quieter agents were briefed
        # twice. Past a certain size the batch is already worth a turn and more
        # waiting only adds latency to work that is piling up.
        if quiet_for < SETTLE and holding_for < MAX_HOLD and len(held.mails) < BATCH_MAX:
            continue

        batch = list(held.mails.values())

        # Compose SERVER-SIDE. The summariser lives in acp-api
        # (api/mail/briefComposer.ts) because it has two callers — this push
        # loop and the agent's own pull (POST /v1/mail/brief/:agent). Two copies
        # of a summariser drift, and the drifted one is the one nobody watches.
        #
        # mark_read:false — the server must NOT mark on compose here. This path
        # still has to land the brief in a turn, and an inject can defer or
        # fail; marking before delivery is confirmed loses mail silently.
        bstatus, bpayload = api(
            f"/v1/mail/brief/{urllib.parse.quote(agent)}",
            method="POST",
            body={"mark_read": False},
            timeout=180,
        )
        bdata = (bpayload or {}).get("data") or {}
        text = sanitise_brief(bdata.get("brief"), agent)
        model_ok = bdata.get("model_ok", True)
        if bstatus != 200 or not text:
            msg = (bpayload or {}).get("message") or f"HTTP {bstatus}"
            log(f"ALERT {agent}: brief compose failed ({str(msg)[:120]}) - {len(batch)} mail held")
            continue

        rows = [
            {"inbox_id": m.get("inbox_id"), "message_id": m.get("message_id")}
            for m in batch
        ]

        status, payload = api(
            f"/v1/lifecycle/agents/{urllib.parse.quote(agent)}/inject",
            method="POST",
            body={"text": text},
            timeout=30,
        )
        result = ((payload or {}).get("data") or {}).get("result", "unknown")

        if status == 200 and result == "delivered":
            # Delivered — NOW it may stop being re-offered. Marking is the
            # server's one implementation (mailProxy markRowsRead), which marks
            # by inbox_id and verifies the row it touched.
            _, cpayload = api(
                f"/v1/mail/brief/{urllib.parse.quote(agent)}/confirm",
                method="POST",
                body={"rows": rows},
                timeout=60,
            )
            marked = len(((cpayload or {}).get("data") or {}).get("marked_read") or [])
            log(
                f"{agent}: BRIEF DELIVERED - {len(batch)} mail -> 1 turn"
                f"{'' if model_ok else ' (degraded: summariser down)'}"
                f", {marked}/{len(batch)} marked read"
            )
            if marked != len(batch):
                log(f"ALERT {agent}: {len(batch) - marked} message(s) failed to mark read - they will re-brief")
            state[agent] = Held()
        elif status == 202 or result == "deferred":
            # Working. Exactly what we want to protect - say nothing, come back.
            log(f"{agent}: mid-turn, brief held ({len(batch)} mail, {int(holding_for)}s)")
            held.last_change = now  # re-arm the settle window; retry next sweep
        elif status == 404:
            log(f"{agent}: no live ACP session - {len(batch)} mail held")
        else:
            msg = (payload or {}).get("message") or result
            log(f"ALERT {agent}: inject failed (HTTP {status}) {str(msg)[:120]} - {len(batch)} mail held")


def main() -> int:
    ap = argparse.ArgumentParser(description="ProjectBriefr - agent mail router")
    ap.add_argument("--once", action="store_true", help="one sweep, then exit")
    args = ap.parse_args()

    log(f"[start] ProjectBriefr - api={ACP_API} (summariser: acp-api /v1/mail/brief)")
    log(
        f"[start] interval={INTERVAL}s settle={SETTLE}s batch-max={BATCH_MAX} "
        f"max-hold={MAX_HOLD}s identity={IDENTITY}"
    )

    state: dict[str, Held] = {}
    while True:
        try:
            agents = discover_roster()
            if agents:
                sweep(state, agents)
            else:
                log("no roster - nothing watched this sweep")
        except KeyboardInterrupt:
            log("[stop] ProjectBriefr shutting down")
            return 0
        except Exception as e:
            # Never die on one bad sweep, never pretend it went fine.
            log(f"ALERT sweep failed: {type(e).__name__}: {e}")

        if args.once:
            return 0
        try:
            time.sleep(INTERVAL)
        except KeyboardInterrupt:
            log("[stop] ProjectBriefr shutting down")
            return 0


if __name__ == "__main__":
    sys.exit(main())
