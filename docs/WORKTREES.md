# ACP Desktop Worktrees

Canonical locations for git worktrees. Use sibling layout under `E:\Repos\` — not nested subdirectories.

## Active Worktrees

| Worktree | Path | Parent | Purpose | Branch |
|----------|------|--------|---------|--------|
| **session-summary-rag** | `E:\Repos\session-summary-rag` | acp-desktop | Session summary → RAG architecture; full session dump in KB + short summary at boot | `session-summary-rag` |

## Worktree Rules

1. **Sibling layout:** Create at `E:\Repos\<name>\`, not nested under parent or `_worktrees/`
2. **Document here:** Add a row above, then store the entry in the KB (vibe docs)
3. **Run `git restore`:** After creating a worktree, immediately `cd` into it and run `dotnet restore` (C#) or `npm install` (Node)
4. **Never delete parent:** Parent directory is the `.git` home for all worktrees — deleting it orphans them

## Historical Worktrees

None yet — document them here when retired.
