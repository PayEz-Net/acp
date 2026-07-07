# ACP Design System v1 — Own the Console

**Status:** Draft spec ready for implementation  
**Owner:** BAPert  
**Assignee:** NextPert  
**Scope:** Visual identity + layout rethink for the ACP Desktop main workspace  
**Goal:** Transform the current clumsy, boilerplate-heavy grid into a distinct, operator-first mission-control interface.

---

## 1. Problem Statement

The current ACP main view (`thisishowwecomeout.jpg`) suffers from:

- **Repeated boilerplate** in every agent pane ("yolo agent", token counts, context %, "input" dividers).
- **No visual hierarchy** — status, metadata, content, and input all compete equally.
- **Cramped grid layout** — six panes + a persistent mail sidebar leave no breathing room.
- **Mail noise** — info-tier scout messages bump the unread count and consume ~20 % of horizontal space.
- **Truncated thinking blocks** — intermediate reasoning is shown but clipped, creating visual dead-ends.

## 2. Design Direction

**"ACP Mission Control"** — a dark, high-contrast operator console that belongs to the ACP itself, not to any product brand.

### Personality
- Calm under load.
- Dense when needed, sparse by default.
- Status is glanceable; detail is one click away.

## 3. Design Principles

1. **One agent, one surface.** Each agent pane should feel like a single instrument, not a chat transcript.
2. **Status before prose.** Color + icon + single-line summary first; full output on demand.
3. **No repeated labels.** Show context, tokens, and provider once per pane, and only when useful.
4. **Mail is a signal, not a sidebar.** Collapse info-tier mail; surface only items that need action.
5. **Respect the viewport.** Default layout should be usable on a 1920×1080 display without horizontal truncation.

## 4. Color System

Build on the existing dark foundation but tighten it.

| Token | Value | Usage |
|-------|-------|-------|
| `--acp-bg` | `#0B0F17` | App background |
| `--acp-surface` | `#111827` | Cards, panes |
| `--acp-surface-raised` | `#1F2937` | Headers, hovered surfaces |
| `--acp-border` | `#374151` | Subtle dividers |
| `--acp-border-focus` | `#6366F1` | Focused pane border |
| `--acp-text-primary` | `#F9FAFB` | Primary text |
| `--acp-text-secondary` | `#9CA3AF` | Metadata, timestamps |
| `--acp-text-muted` | `#6B7280` | Disabled, placeholder |
| `--acp-accent` | `#6366F1` | Primary action, focused agent |
| `--acp-accent-hover` | `#4F46E5` | Hover states |
| `--acp-status-ready` | `#10B981` | Ready / online |
| `--acp-status-busy` | `#F59E0B` | Working / composing |
| `--acp-status-idle` | `#3B82F6` | Idle / waiting |
| `--acp-status-error` | `#EF4444` | Error / crashed |
| `--acp-status-offline` | `#6B7280` | Offline / stopped |

Rationale: moves away from the generic slate/purple toward an indigo-accented, ownable palette that still reads as "console".

## 5. Typography

- **Font family:** `Inter` (already in use) for UI; keep `JetBrains Mono` or `Fira Code` for code/terminal blocks.
- **Scale:**
  - Pane title: `14px / font-semibold`
  - Status line: `13px / font-medium`
  - Metadata: `12px / font-normal`
  - Body / output: `13px / font-normal` with `line-height: 1.5`
- **Rules:**
  - No all-caps labels.
  - Use color and weight, not size alone, to create hierarchy.
  - Monospace only for paths, code, token counts, and terminal output.

## 6. Layout Architecture

### 6.1 Default View: "Deck"

Replace the fixed 3×2 grid with a responsive deck that adapts to the number of active agents.

- **2 agents:** 2-column layout, each pane ~50 % width.
- **3–4 agents:** 2-column layout with taller panes; vertical scroll if needed.
- **5–6 agents:** 3-column layout; panes maintain a minimum width of `480px`.
- **> 6 agents:** 3-column layout with overflow / pagination or a compact "strip" mode.

### 6.2 Pane Structure

Each agent pane is a single card:

```
┌─────────────────────────────────────┐
│ ● AgentName    Ready    ···         │  ← Header (40 px)
├─────────────────────────────────────┤
│ Last meaningful output line         │  ← Status line (single line)
│                                     │
│ [ expandable output area ]          │  ← Scrollable content
│                                     │
│ Type a command or message...  [➤]   │  ← Input (48 px)
└─────────────────────────────────────┘
```

**Header:**
- Status dot + agent name + current state label on the left.
- Context usage as a thin progress bar on the right (only on hover or when > 70 %).
- Provider badge (KIMI / Claude) only if mixed providers are in use.

**Status line:**
- One line summarizing the last action: "Composing mail to DotNetPert" or "Waiting for input".
- No "input" dividers. No repeated "yolo agent" labels.

**Content area:**
- Collapsed by default to ~6 lines.
- Expand on click or `Ctrl/Cmd + ↑`.
- Thinking blocks collapsed behind a "Thinking…" pill; click to expand.

**Input:**
- Single-line by default; auto-grow to 3 lines.
- Placeholder: "Message {AgentName}…" instead of generic "Type a command or message".

### 6.3 Navigation / Chrome

- **Top bar:** App title + environment badge (`DEV`, `PROD`, `LIVE DATA`) + global status + window controls.
- **Bottom bar:** Quick toggles for mail, logs, and settings.
- **Mail panel:** Convert from persistent sidebar to a slide-out drawer (width `360px`).
  - Info-tier messages arrive already read and are grouped under "Scout chatter".
  - Normal/high messages appear in a "Needs attention" section.

## 7. Component Guidelines

### Agent Pane
- Background: `--acp-surface`
- Border: `1px solid --acp-border`
- Border radius: `12px`
- Focused state: `border-color: --acp-border-focus`, subtle inner glow.
- Padding: `0` (header/content/input each manage their own).

### Status Pills
Small, rounded labels for agent states:
- `Ready`, `Thinking…`, `Composing…`, `Idle`, `Error`, `Offline`.
- Each maps to the color tokens above.

### Context Bar
- Thin horizontal bar (4 px) at the bottom of the header.
- Green → yellow → red gradient as usage approaches limit.
- Hidden unless usage > 30 % or agent is focused.

### Mail Drawer
- Slide in from the right with overlay backdrop.
- Two sections: `Needs attention` (normal/high) and `Scout chatter` (info).
- Unread count shown on the bottom-bar mail icon only.

## 8. Interaction Details

- **Pane focus:** click to focus; focused pane gets the accent border.
- **Keyboard:**
  - `Tab` cycles panes.
  - `Shift + Tab` cycles backwards.
  - `Ctrl/Cmd + M` toggles mail drawer.
  - `Ctrl/Cmd + 1–6` focuses pane by position.
- **Resize:** panes in 3-column layout are not individually resizable; the deck reflows with the window.

## 9. Acceptance Criteria

- [ ] Main workspace uses the new color tokens and no pane repeats boilerplate labels.
- [ ] Agent panes render in the Deck layout and reflow correctly at 1920×1080, 2560×1440, and 1366×768.
- [ ] Status line summarizes the last meaningful action in one line.
- [ ] Thinking blocks are collapsed by default.
- [ ] Mail sidebar is replaced by a slide-out drawer with info-tier messages grouped separately.
- [ ] No visual truncation of essential text at default sizes.
- [ ] Existing functionality (send message, read mail, resize, focus) remains intact.

## 10. Out of Scope (for v1)

- New animations beyond the existing float/dash.
- Custom agent avatars or sprites.
- Light mode.
- Mobile / touch layout.

## 11. Risks

- **Scope creep:** resist adding new features; this is a reskin + layout refactor, not a feature release.
- **Color contrast:** verify all status colors pass WCAG AA against `--acp-surface`.
- **Mail behavior change:** users may expect the sidebar; document the drawer toggle.

## 12. Implementation Notes

- Update `src/renderer/styles/globals.css` with new tokens.
- Extend `tailwind.config.js` with the ACP palette (or use CSS variables directly).
- Primary components to touch:
  - `src/renderer/components/ACP/ACPCanvas.tsx`
  - `src/renderer/components/ACP/AgentDetail.tsx`
  - `src/renderer/components/ACP/EventLog.tsx`
  - `src/renderer/components/Layout/TeamGrid.tsx`
  - `src/renderer/components/Mail/MailSidebar.tsx`
- Run impact analysis with GitNexus before editing each component per `AGENTS.md`.

## 13. Agent Stream Hygiene

The main agent panes currently leak terminal TUI artifacts: `yolo agent`, `context: 5.2%`, token counters, `— input`, `ctrl-o: editor`, `jnewline`, and spinner frames. These must not reach the user-facing surface.

### Requirements
- **Aggressive footer suppression:** provider status bars, context percentages, token counters, cost summaries, `yolo agent` headers, input separators (`— input`), and keybinding hints (`ctrl-o: editor`, `jnewline`) must never surface in a pane.
- **Frame deduplication:** repeating TUI frames that differ only by spinner position, timestamp, or numeric value must collapse to a single live placeholder or be dropped entirely.
- **Thinking isolation:** thinking content is captured but hidden behind a collapsed `Thinking…` pill; live placeholders use one consistent label.
- **Renderable formatting:** Markdown and ANSI in actual agent responses is rendered, not printed as raw text.

### Implementation Notes
- `src/renderer/lib/terminalStream.ts` already has footer and dedup logic; the current implementation is leaking. Audit the `FOOTER_LINE`, `SPINNER_GLYPHS`, `STATUS_GLYPHS`, and `THINKING_LABEL` regexes against the observed junk in `thisishowwecomeout.jpg` and tighten them.
- Consider a stricter "pane stream" pass that drops anything classified as footer/separator/thinking noise, while the full raw stream remains available in `AgentOutputPanel` for debugging.
- Ensure `AgentOutputPanel` and the main ACP agent panes consume the same normalized stream.
- Add unit tests for each junk pattern observed in the screenshot, especially footer variants and repeating frames.

## 14. Success Metrics

- Screenshot review: no red-marked clumsy areas.
- User can identify each agent's state in < 2 seconds.
- Info-tier mail does not interrupt workflow.
- No provider TUI artifacts (`yolo agent`, context %, `— input`, keybinding hints, spinner frames) appear in agent panes.
