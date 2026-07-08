# Terminal Kimi-Format Emulation Project

**Status:** Initiated — research and planning phase  
**Owner:** BAPert (Business Analyst / team lead)  
**Implementers:** NextPert (primary), NextPert-Scout (support)  
**QA:** QAPert  
**Stakeholder:** Jon

## Problem Statement

ACP Desktop’s terminal pane is the face of the product. When a Kimi team is active, the output should look like the native `kimi-code` CLI. Previous ad-hoc regex-and-patch work cleared some TUI clutter but introduced visual rough spots:

- Orphaned ANSI/TUI fragments leaking into the transcript (`:32`, `:47`, `78`, `50:`, etc.)
- Thinking blocks fracturing into stacked single-line noise
- Left-aligned/wrapped thinking content without proper indentation
- Inline ACP Mail notifications and system text rendered as part of the stream
- Overall lack of the clean, grouped, transcript-style feel of the native CLI

This project will build a professional, researched Kimi-native terminal renderer. Claude and Codex native formatting are future phases; the Kimi renderer must be accepted first.

## Project Phases

### Phase 1: Research (1–2 days)

**Goal:** Build a precise understanding of how `kimi-code` renders terminal output.

**Reference material:**
- Native `kimi-code` CLI at `E:\Repos\kimi-code`
- `@moonshot-ai/pi-tui` markdown and text components
- `apps/kimi-code/src/tui/components/messages/*`
- `apps/kimi-code/src/tui/theme/*`
**Research questions (Kimi focus):**
1. How does Kimi CLI detect and render thinking/reasoning blocks?
2. How are lists (ordered, unordered, nested), code blocks, quotes, and tables formatted?
3. What are the exact colors, fonts, spacing, and indentation rules?
4. How does it handle streaming/partial output without flicker or fracture?
5. How are user messages, tool calls, status messages, and system notifications grouped?
6. What ANSI sequences does Kimi emit, and how should they be stripped/preserved?

**Future scope (not part of this project):**
- Claude Code native formatting
- Codex CLI native formatting
- Generalized provider-adapter surface

**Deliverable:** Research notes document shared with the team before the round table.

### Phase 2: Round Table

**Attendees:** BAPert, NextPert, NextPert-Scout, QAPert, DotNetPert (optional)

**Agenda:**
1. Present Kimi research findings.
2. Review screenshot regressions and failure modes.
3. Propose Kimi-specific architectural approaches (e.g., structural parsing vs. regex normalization, markdown rendering, line-based vs. turn-based grouping).
4. Discuss trade-offs: complexity, performance, maintainability, testability.
5. Agree on the Kimi-only implementation plan and acceptance criteria.
6. Note future Claude/Codex phases but do not design for them yet.

**Deliverable:** Decision record with chosen approach and rough task breakdown.

### Phase 3: Reviewed Plan

**Goal:** Produce a detailed implementation plan accepted by Jon and the team.

**Contents:**
- Kimi-native visual specification
- ACP chrome/structure vs. Kimi-specific rendering
- Data flow changes (where parsing/normalization happens)
- File-by-file change list
- Test strategy and fixtures
- Risk list and rollback plan
- Definition of done

**Deliverable:** `docs/TERMINAL_KIMI_FORMAT_PLAN.md` approved via mail or round-table sign-off.

### Phase 4: Implementation

**Goal:** Execute the approved plan.

**Rules:**
- NextPert / NextPert-Scout own all TypeScript implementation.
- BAPert owns requirements and acceptance criteria.
- QAPert owns acceptance verification against reference screenshots and the native CLI.
- No code merges without QAPert sign-off.

## Immediate Hold

- `WO-TERM-FORMAT-REVIEW-20260708` is on hold.
- No further ad-hoc terminal formatting changes until the reviewed plan is accepted.

## Reference Screenshots

- `E:\Repos\Agents\NextPert\gettingweirdleftalinged.jpg`
- `E:\Repos\Agents\NextPert\stillgettingadfe.jpg`
- `E:\Repos\Agents\NextPert\thinkgifssred.jpg`
- `E:\Repos\Agents\NextPert\icantgfefedfee.jpg`
