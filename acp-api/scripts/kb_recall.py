#!/usr/bin/env python3
"""UserPromptSubmit hook: retrieve relevant memories from the 93 kb store.

Replaces the flat MEMORY.md index. The user's prompt IS the query, so retrieval
is query-driven instead of loading 300 memories into every session.

Reads the hook payload as JSON on stdin, prints matching memories on stdout;
Claude Code adds stdout to the turn's context.

FAILS OPEN, LOUDLY. If 93 or the embedder is unreachable this prints a one-line
notice and exits 0 — a memory store being down must never block the user's
prompt. The notice is there so a silent degradation is still detectable
(a fallback you cannot see is the hole).

Config via env:
  KB_RECALL_K       how many memories to inject (default 6)
  KB_RECALL_OFF     set to 1 to disable
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request

OLLAMA = os.environ.get("KB_OLLAMA_URL", "http://10.0.0.220:11434")
K = os.environ.get("KB_RECALL_K", "6")
SSH = ('ssh -o ConnectTimeout=4 -o BatchMode=yes -i ~/.ssh/dotnetpert_93 '
       'dotnetpert@10.0.0.93 "sudo docker exec -i kb-postgres psql -U kb -d kb -tA -f -"')
# psql's -F separator does not survive the nested ssh/docker quoting, so the
# delimiter is built into the SELECT instead.
SEP = "|@@|"
MIN_CHARS = 12          # below this a prompt carries no retrievable intent
# Some memories are very long (one is 51KB). Injecting 6 of those into every
# prompt would cost more context than the flat index we are replacing.
CHUNK_CHARS = 1200
TIMEOUT_EMBED = 8
TIMEOUT_QUERY = 12


def note(msg):
    """Visible degradation notice — never silent."""
    print(f"[kb-recall: {msg}]", file=sys.stderr)


def embed(text):
    req = urllib.request.Request(
        f"{OLLAMA}/api/embeddings",
        data=json.dumps({"model": "nomic-embed-text", "prompt": text[:4000]}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_EMBED) as r:
        return json.load(r)["embedding"]


def psql(sql):
    """Run SQL on the kb box. Returns stdout, or None if unreachable."""
    fd, path = tempfile.mkstemp(suffix=".sql")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(sql)
        r = subprocess.run(f'cat "{path}" | {SSH}', shell=True, capture_output=True,
                           text=True, encoding="utf-8", timeout=TIMEOUT_QUERY)
    except Exception as e:
        note(f"kb unreachable ({type(e).__name__})")
        return None
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if r.returncode != 0:
        note(f"query failed: {r.stderr.strip()[:160]}")
        return None
    return r.stdout


def emit_boot_summary(agent):
    """Inject THIS agent's own latest session summary, and nothing else.

    Scoped on scope_id = the agent, exactly, so a prefix like QAPert can never
    pick up QAPert-NightHawk's state. No summary means NO OUTPUT — an agent
    that genuinely has no prior state must start clean rather than be handed
    the nearest thing, which is how the bleed happened in the first place.
    """
    a = agent.replace("'", "''")
    out = psql(
        "select title || '" + SEP + "' || coalesce(source,'') || '" + SEP + "' || chunk "
        "from kb where scope = 'agent' and scope_id = '" + a + "' "
        "and title like '%session summary%' "
        "and (expires_at is null or expires_at > now()) "
        "order by created_at desc limit 1;\n")
    if out is None:
        return False
    rows = []
    for ln in out.splitlines():
        if ln.count(SEP) == 2:
            rows.append(ln.split(SEP, 2))
        elif rows:
            rows[-1][2] += "\n" + ln
    if not rows:
        note(f"no stored session summary for {agent} — starting clean")
        return False
    title, source, chunk = rows[0]
    print(f"Where {agent} left off. This is a stored summary of a PREVIOUS session, "
          f"not live state — the rig has restarted and other agents have moved since. "
          f"Verify anything here against the live system before acting on it.\n")
    print(f"<session-summary agent=\"{agent}\" source=\"{source}\">\n"
          f"{chunk.replace(chr(92) + 'n', chr(10)).strip()}\n</session-summary>\n")
    return True


# Identity markers, in confidence order. The agent's name is never in the hook
# payload, so it is recovered from what the session has already done: the
# onboarding banner, then the ACP calls it makes as itself.
NOT_AN_AGENT = {"me", "agent", "name", "claude", "main", "test"}
BOOT_STATE = os.path.join(os.path.expanduser("~"), ".claude", "kb-recall-boot")


def resolve_agent():
    """Who is this session? Ask the runtime, do not infer it.

    ACP_AGENT_NAME is set per pane by the shell at spawn (pty.ts:1301) and hooks
    inherit the process environment. It is authoritative: the shell decided who
    this pane is before the agent said a word.

    THREE INFERENCE ATTEMPTS FAILED FIRST, and each failed differently — worth
    keeping, because each was plausible:

      `report as <Agent>` in the prompt — the shell's first prompt is actually
      `Begin.`, which carries no name and is below this hook's length floor, so
      the trigger could never fire.

      `X-ACP-Agent:` in the transcript — says who the session is CALLING AS, not
      who it IS. My own transcript has 18 hits for BAPert; resolving on it would
      have handed BAPert's state to a session that is not BAPert.

      `✓ <Agent> initialized` onboarding banner — absent from every resumed
      session, because resuming does not re-onboard. Zero matches on a real
      BAPert transcript.

    A value the runtime already knows beats three signals that only correlate
    with it. Absent the variable, inject nothing: a session outside the ACP is
    not an agent and has no summary to resume.
    """
    name = (os.environ.get("ACP_AGENT_NAME") or "").strip()
    if not name or name.lower() in NOT_AN_AGENT:
        return None
    return name


def try_boot_injection(payload):
    """Inject this agent's own last summary ONCE per session. True if handled.

    Not keyed on the prompt text. The shell's first prompt is `Begin.` — it
    carries no agent name and is shorter than the hook's own length floor, so
    anything triggered by matching it would never fire. Instead: on any prompt,
    if this session has not yet been given its summary, work out who it is and
    give it exactly one.
    """
    session = payload.get("session_id") or payload.get("sessionId")
    if not session:
        return False

    marker = os.path.join(BOOT_STATE, str(session))
    if os.path.exists(marker):
        return False

    agent = resolve_agent()
    if not agent:
        # Not an ACP pane (no ACP_AGENT_NAME). Not an error — this hook also
        # runs in ordinary sessions, which have no agent identity and no
        # summary to resume.
        return False

    try:
        os.makedirs(BOOT_STATE, exist_ok=True)
        with open(marker, "w", encoding="utf-8") as f:
            f.write(agent)
    except OSError:
        pass  # marker is an optimisation; a repeat injection beats none

    return emit_boot_summary(agent)


def main():
    if os.environ.get("KB_RECALL_OFF") == "1":
        return
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    prompt = (payload.get("prompt") or "").strip()

    # Boot injection runs BEFORE the length floor and regardless of the prompt
    # text. MEASURED 2026-08-09: the shell's first prompt to a spawned agent is
    # `Begin.` — six characters, under MIN_CHARS, so the hook returned before
    # doing anything. My first attempt keyed on `report as <Agent>`, which is
    # what pty.ts writes into the PTY, not what arrives as the hook's prompt.
    # The agent's NAME is therefore not in the prompt at all, so identity has to
    # come from the transcript.
    if try_boot_injection(payload):
        return

    if len(prompt) < MIN_CHARS:
        return

    try:
        vec = embed(prompt)
        qe = "'[" + ",".join(f"{x:.6f}" for x in vec) + "]'::vector"
    except Exception as e:
        note(f"embedder unreachable ({type(e).__name__}) — lexical only")
        qe = "NULL"

    # ── BOOT MODE ────────────────────────────────────────────────────────
    # The shell injects `report as <Agent>` as an agent's first prompt, so this
    # is the first and only moment the hook learns WHO it is running for.
    #
    # Two things happen here, and the second is a defect fix:
    #
    # 1. The agent's own latest session summary is injected deliberately,
    #    scoped to it. Before this it arrived by lexical luck — `report as
    #    BAPert` happened to match a row titled "BAPert session summary" and
    #    landed 4th of 6, so it would silently drop off as soon as anything
    #    else matched better.
    #
    # 2. MEASURED 2026-08-09: `report as QAPert` returned QAPert-NIGHTHAWK's
    #    session summary. QAPert's own was correctly refused for establishing
    #    no state, so it had none, and prefix-matching handed it a DIFFERENT
    #    AGENT'S state as its boot context. An agent would resume believing it
    #    left off inside someone else's work. kb_search's scope filter would
    #    have prevented it, but this hook passes NULL scope because in normal
    #    use it has no idea which agent it serves.

    q = prompt.replace("'", "''")
    # Two queries, because kb_search's rank SCALE still favours keywords:
    # its lexical branches carry fixed boosts (+3.0 lex_and / 2.0 ident /
    # +1.0 lex_or) while the semantic branch maxes out at 1.0, so ANY weak
    # keyword match outranks the best semantic hit. Keyword recall would drown
    # out intent on every natural-language question.
    #
    # So: half the slots from kb_search (exact identifiers, error strings), half
    # from a pure cosine search (intent). Neither can crowd the other out.
    #
    # (kb_search's ORDER BY was fixed 2026-08-10 — it now returns rank DESC and
    # applies k to the union, so the outer sort below is belt-and-braces rather
    # than load-bearing. The scale imbalance above is what still needs the split.)
    half = max(1, int(K) // 2)
    proj = (f"title || '{SEP}' || coalesce(source,'') || '{SEP}' || "
            f"left(chunk, {CHUNK_CHARS})")
    sql = (f"select {proj} from (select * from kb_search('{q}', {qe}, NULL, NULL, {K})) s where s.scope <> 'agent' "
           f"order by rank desc limit {half};\n")
    if qe != "NULL":
        # kb_search filters expired notes internally; this query bypasses it and
        # reads kb directly, so it must carry the same predicate or expired
        # notes come back through the semantic half only — a half-applied filter
        # is harder to notice than none at all.
        sql += (f"select {proj} from kb where embedding is not null "
                f"and scope <> 'agent' "
                f"and (expires_at is null or expires_at > now()) "
                f"order by embedding <=> {qe} limit {half};\n")

    fd, path = tempfile.mkstemp(suffix=".sql")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(sql)
        r = subprocess.run(f'cat "{path}" | {SSH}', shell=True, capture_output=True,
                           text=True, encoding="utf-8", timeout=TIMEOUT_QUERY)
    except Exception as e:
        note(f"kb unreachable ({type(e).__name__}) — no memories injected")
        return
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    if r.returncode != 0:
        note(f"query failed — no memories injected: {r.stderr.strip()[:160]}")
        return

    # A chunk contains newlines, so one row spans several output lines: start a
    # new record only on a line carrying the separator, and append the rest.
    rows = []
    for ln in r.stdout.splitlines():
        if ln.count(SEP) == 2:
            rows.append(ln.split(SEP, 2))
        elif rows:
            rows[-1][2] += "\n" + ln
    # The two queries can surface the same memory; keep first occurrence.
    seen, deduped = set(), []
    for row in rows:
        if row[0] not in seen:
            seen.add(row[0])
            deduped.append(row)
    rows = deduped
    if not rows:
        note("no matching memories")
        return

    print("Relevant stored memories (retrieved from the shared kb store on 93, "
          "ranked by relevance to this prompt). These are point-in-time notes, not "
          "live state — verify file:line claims against current code before asserting "
          "them as fact.\n")
    for title, source, chunk in rows:
        # psql renders embedded newlines literally; restore them for readability.
        body = chunk.replace("\\n", "\n").strip()
        # Not a markdown heading: chunk bodies contain their own `###` headings,
        # and a colliding marker makes the record boundary unfindable.
        print(f"<memory title=\"{title}\" source=\"{source}\">\n{body}\n</memory>\n")


if __name__ == "__main__":
    main()
