# ACP Output Frame

A shared response-formatting spec for every coding agent that touches this repo.
Goal: one predictable shape no matter whether the agent is Kimi, Claude, Codex, or the next one.

## 1. Voice

- **Direct.** No hedging ("I think", "maybe", "perhaps"). State facts and confidence levels when they matter.
- **Concise.** Prefer one clause over two. If a sentence can be cut, cut it.
- **Action-first.** Start with what was done or what will happen, then why.
- **No emoji** in technical output unless the user explicitly asks. Use status words and structured blocks instead.
- **No pseudo-politeness.** No "Let me know if you need anything else." End with facts or a clear question.

## 2. Verdict First

Every response must open with a one-line verdict. The user should know the answer after reading the first sentence.

Good:
> Stream normalizer tightened against the exact junk still leaking in the fresh screenshot.

Bad:
> I looked at the screenshot you sent and noticed some junk lines...

## 3. Universal Structure

Every non-trivial response should follow this skeleton:

```
[One-line verdict / headline]

[Context snippet — 1-2 sentences only if needed]

## Changes
- file/path.ts — what changed and why
- file/path2.ts — what changed and why

## Verification
- Command — result
- Command — result

## Next / Open
- Optional follow-ups or blockers
```

Use `##` for top-level sections. Avoid `#` inside a response; the user already knows what they asked.

## 4. Response-Type Templates

### 4.1 Code Change

```markdown
[One-line verdict].

## Changes
- `path/to/file.ts:line` — change description.
- `path/to/file2.ts:line` — change description.

## Verification
- `npx tsc --noEmit` — PASS
- `npm run test -- --run` — PASS (N tests)
- `npx vite build` — PASS

## Next
- Optional follow-up.
```

### 4.2 Research / Debug

```markdown
[One-line finding].

## Where
- `path/to/file.ts:line` — relevant code / suspect location.
- `path/to/file2.ts:line` — related code.

## What I Checked
- `command` — result.
- `command` — result.

## Diagnosis
[2-3 sentences explaining root cause or current state.]

## Recommended Fix
[Concrete next step or options.]
```

### 4.3 Plan

```markdown
Plan: [one-line summary].

## Scope
[What is in scope and what is explicitly out of scope.]

## Steps
1. Step one.
2. Step two.
3. Step three.

## Risks / Decisions
- Decision: [trade-off].
- Risk: [risk].

## Verification
- `command` — expected result.
```

### 4.4 Screenshot Observation

```markdown
[One-line summary of what the screenshot shows].

## Observations
- Element at [relative coords] — observation.
- Element at [relative coords] — observation.

## Diagnosis
[What the screenshot implies about the bug or state.]

## Recommended Fix
[Concrete next step.]
```

### 4.5 Agent Handoff

```markdown
Handoff: [one-line summary].

## Context
[What the next agent needs to know.]

## Completed
- Done item.
- Done item.

## Next
- Next item with file/path reference.
- Next item with file/path reference.

## Blockers
- `BLOCKED:` item requiring user or external action.
```

## 5. File References

- Always use relative paths from repo root: `src/renderer/App.tsx`, not `App.tsx`.
- For code snippets, include the full file path in the fenced language tag when possible:
  ` ```tsx src/renderer/components/Layout/BottomBar.tsx `
- When quoting line numbers, format as `path:line` (e.g., `src/main/index.ts:42`).

## 6. Lists

- Use `-` for unordered lists. No `*`.
- Use `1.` for ordered lists only when order truly matters (steps, priorities).
- Keep list items parallel: all noun phrases or all full sentences. Prefer fragments.
- One idea per item. Do not nest more than two levels.
- If a section exceeds 6 bullets, split or summarize.

## 7. Code Blocks

- Always specify the language. Never leave a fence blank.
- Keep snippets minimal: show the changed region plus 2-3 lines of context.
- For diffs, use ` ```diff ` with `+` / `-` markers only when the change is small and local.
- For multi-file changes, prefer one block per file rather than one giant block.

## 8. Status Indicators

Use these exact words for outcomes. Do not invent synonyms.

| Word | Meaning |
|------|---------|
| `PASS` | Verification succeeded, no concerns. |
| `FAIL` | Verification failed; fix required before proceeding. |
| `WARN` | Succeeded, but with caveats, deprecations, or known debt. |
| `SKIP` | Deliberately not run or not applicable. |
| `BLOCKED` | Cannot proceed without user input or external dependency. |

In prose, write: `Typecheck: PASS`, `Build: WARN (chunk size > 500 kB)`.

## 9. Verification Block

Every code change must end with a verification block in this exact shape:

```markdown
## Verification
- `npx tsc --noEmit` — PASS
- `npm run test -- --run` — PASS (127 tests)
- `npx vite build` — WARN (chunk size 766 kB)
```

If verification was not run, say why: `- `npx vite build` — SKIP (user asked to avoid builds in ACP workspace)`.

## 10. Decision Notes

When a trade-off is made, capture it in one line:

```markdown
Decision: Moved `<LogViewer />` inside the main flex area so it renders as a right-side panel alongside `<MailSidebar />`.
```

This keeps rationale discoverable without bloating the response.

## 11. Forbidden Phrases

Do not use these. They add noise and reduce confidence.

- "I think..."
- "Maybe..."
- "Perhaps..."
- "Let me know if you need anything else."
- "I hope this helps."
- "As you can see..."
- "I'm just..."
- "It seems like..."

## 12. What to Avoid

- Avoid walls of text. If a section exceeds 6 bullets, split or summarize.
- Avoid repeating the user's prompt back to them.
- Avoid markdown tables for simple lists.
- Avoid sign-offs. End with facts or a clear question.
- Avoid over-explaining. The user asked for the job; deliver the job.

## 13. Example Response

```markdown
Stream normalizer tightened against the exact junk still leaking in the fresh screenshot.

## Changes
- `src/renderer/lib/terminalStream.ts:89` — expanded `FOOTER_LINE` to catch slash commands (`/feedback`, `/theme`), typo commands (`thme:`), and typo keybindings (`crl-vpaste`, `ctl-x:`).
- `src/renderer/lib/terminalStream.test.ts` — added `freshscrenshot.jpg` regression test with 17 screenshot-derived junk lines.

## Verification
- `npx tsc --noEmit` — PASS
- `npm run test -- --run` — PASS (128 tests)
- `npx vite build` — PASS

## Next
- Reload the app and confirm the pane stream is clean on the next screenshot.
```

---

Adopt this frame for every task. If the frame conflicts with a user request, the user request wins — but note the override in the response.
