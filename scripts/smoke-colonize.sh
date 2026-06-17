#!/usr/bin/env bash
# Smoke-test the freshly-built colonizer (WO #5).
# Scenario A: fresh colonize delivers BOTH .claude/skills + .kimi/skills, mail = agent-mail.
# Scenario B: re-materialize (forced by a new agent) PRESERVES a pre-existing sibling skill
#             (the destructive-replace regression, on the real packaged binary).
set -u
EXE="release/win-unpacked/ACP.exe"
[ -f "$EXE" ] || { echo "FAIL: $EXE not found (build first)"; exit 2; }

run_colonize() { # <root> <agents-csv>
  local root="$1" agents="$2" log="$1/_colonize.log"
  rm -f "$log"
  "$EXE" --acp-colonize "$root" --acp-colonize-log "$log" --agents "$agents" >/dev/null 2>&1 &
  # GUI-subsystem exe detaches; wait on the log file the batch path writes last.
  for _ in $(seq 1 60); do [ -f "$log" ] && break; sleep 0.5; done
  sleep 0.5
}

pass=0; fail=0
chk() { if eval "$2"; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }

TMPA="$(mktemp -d)"; TMPB="$(mktemp -d)"
trap 'rm -rf "$TMPA" "$TMPB"' EXIT

echo "== Scenario A: fresh colonize ($TMPA) =="
run_colonize "$TMPA" "BAPert,QAPert"
chk ".claude/settings.json"                  "[ -s '$TMPA/.claude/settings.json' ]"
chk ".claude/commands/report-bapert.md"      "[ -s '$TMPA/.claude/commands/report-bapert.md' ]"
chk ".kimi/kimi.json"                        "[ -s '$TMPA/.kimi/kimi.json' ]"
chk ".claude/skills/agent-mail/SKILL.md"     "[ -s '$TMPA/.claude/skills/agent-mail/SKILL.md' ]"
chk ".kimi/skills/agent-mail/SKILL.md"       "[ -s '$TMPA/.kimi/skills/agent-mail/SKILL.md' ]"
chk ".claude/skills has acp-kanban"          "[ -d '$TMPA/.claude/skills/acp-kanban' ]"
chk "claude mail skill name: agent-mail"     "grep -q '^name: agent-mail' '$TMPA/.claude/skills/agent-mail/SKILL.md'"
chk "kimi mail skill name: agent-mail"       "grep -q '^name: agent-mail' '$TMPA/.kimi/skills/agent-mail/SKILL.md'"
chk "NO stray acp-mail skill"                "[ ! -e '$TMPA/.claude/skills/acp-mail' ] && [ ! -e '$TMPA/.kimi/skills/vibe-mail' ]"
echo "  claude skills: $(ls "$TMPA/.claude/skills" 2>/dev/null | tr '\n' ' ')"
echo "  kimi   skills: $(ls "$TMPA/.kimi/skills"   2>/dev/null | tr '\n' ' ')"

echo "== Scenario B: merge preserves sibling on re-materialize ($TMPB) =="
run_colonize "$TMPB" "BAPert"
mkdir -p "$TMPB/.claude/skills/custom"
echo "CUSTOM-DO-NOT-LOSE" > "$TMPB/.claude/skills/custom/SKILL.md"
run_colonize "$TMPB" "BAPert,QAPert"   # new agent → claude.check fails → re-materialize
chk "new report-qapert.md landed"            "[ -s '$TMPB/.claude/commands/report-qapert.md' ]"
chk "custom sibling SURVIVED"                "[ -f '$TMPB/.claude/skills/custom/SKILL.md' ]"
chk "custom content intact"                  "grep -q 'CUSTOM-DO-NOT-LOSE' '$TMPB/.claude/skills/custom/SKILL.md'"

echo ""; echo "RESULT: $pass passed, $fail failed"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
