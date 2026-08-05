# Propagation map — which copies are SOURCES and which are GENERATED

**Card:** 170676 · **Author:** QAPert · **Measured:** 2026-08-05, all claims executed not inferred

> **The defect this document exists to prevent:** a fix that is correct, verified, and lands in a
> copy that nothing reads. `167116` fixed the `acp-kanban` skill in one location of six; BAPert
> shipped the same one-copy fix to `kanban/board.js` an hour later against a different artifact.
> **Nobody had written down which copies are which. That is the actual defect.**

---

## 1. The rule

```
GENERATED   fixed by REBUILDING. Editing by hand is wrong and creates drift.
SOURCE      must each be fixed, or the fix is one repo deep.
TRANSIENT   branch/worktree state. Resolved by whatever merges. Do not chase.
VESTIGIAL   tracked, on no route, read by nothing found. Delete or document why it stays.
```

**A fix is not done when the file is right. It is done when the file the ARTIFACT TRAVELS THROUGH
is right** — which is `docs/20` reachability at the distribution layer.

---

## 2. `acp-kanban` skill — the measured map

| Path | Class | Evidence |
|---|---|---|
| `colonize-templates/.claude/skills/` | **SOURCE — the only one on the route** | `src/main/colonize/registry.ts:101` copies `tpl/.claude/skills` → workspace `skills/`; `tpl` resolves to `colonize-templates` |
| `release/mac/ACP.app/.../colonize-templates/` | **GENERATED** | `.gitignore:6` ignores `release/`; `package.json:91-92` `from: colonize-templates → to: colonize-templates` (electron-builder extraResources) |
| `.claude/worktrees/turn-lifecycle/**` (×2) | **TRANSIENT** | untracked worktree state |
| `skills/acp-kanban/` | **VESTIGIAL** | tracked, but no colonize path reads it. The only `package.json` reference to `skills/` is `skills/acp-skills.json`, a different file |
| `~/Repos/.claude/skills/acp-kanban/` | **the only FIXED copy** | outside `acp-desktop`; `~/Repos` is not a git repository |

### 2.1 The finding that follows from the table

**The fix landed in the one location that is on nobody's propagation route and in no git
repository.** It is correct, and it reaches exactly one team's working directory.

### 2.2 The two tracked copies are identical BY LUCK

```
skills/acp-kanban/SKILL.md                        md5 04f1d37882cddef4171bf0decd99ed72
colonize-templates/.claude/skills/.../SKILL.md    md5 04f1d37882cddef4171bf0decd99ed72
```
**No script syncs them.** Both were last touched by a single commit — `3f990ec`, the initial
public release. **They have never diverged because neither has ever been edited.** The first
edit to either one silently desynchronises them, and nothing reports it.

This is the same shape BAPert found in `acp-api`: *"currently identical apart from today's
guard. That is luck, not a process."* **Here it is starker — the mechanism keeping them equal
is that nobody has touched them.**

---

## 3. Verification is BY THE ROUTE, never by the file

Reading a file proves the file. **It does not prove what an agent receives.** The route:

```bash
node scripts/manual-colonize.cjs /tmp/colonize-probe      # explicit root — it DEFAULTS to ~/Repos
grep -c 'assignedTo' /tmp/colonize-probe/.claude/skills/acp-kanban/SKILL.md   # must be 0
grep -c '/status'    /tmp/colonize-probe/.claude/skills/acp-kanban/SKILL.md   # must be >0
```

**Measured 2026-08-05, before the propagation fix:**
```
landed at                : /tmp/colonize-probe/.claude/skills/acp-kanban/SKILL.md
teaches PATCH assignedTo : 1
documents PUT /status    : 0
md5                      : 04f1d37882cddef4171bf0decd99ed72   (the stale source, byte-identical)
```
**A newly colonised project receives three API calls that fail against the live API.**

---

## 4. An existing drift detector nobody is using

`registry.ts` already has one, and its docstring states the contract:

> `dirMatchesTemplate(tplDir, destDir)` — *"Returns true when every file in tplDir exists in
> destDir with identical content."*

**It compares template against destination, so it detects a colonised project drifting from the
template.** It does **not** detect the template itself being stale, and it cannot — the template
is its own reference. **A drift detector cannot tell you its reference is wrong**, which is the
undeclared-denominator shape (`docs/21`) at the distribution layer.

---

## 5. Open — needs an owner, not a measurement

**`acp-api` leadership is undecided** (card 170676 DoD 4): the standalone repo and
`acp-desktop/acp-api/` vendored copy are currently identical apart from today's guard. **Which
one leads is a decision, and it is not mine.** Until it is recorded, every `acp-api` fix has
this bug.

**`skills/` (vestigial) — delete or document.** I found no reader. **I have not deleted it**:
absence of a reader in this repo is not proof of no reader anywhere, and that is exactly the
inference this document exists to discourage.
