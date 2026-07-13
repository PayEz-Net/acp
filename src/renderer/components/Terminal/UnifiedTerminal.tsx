/**
 * UnifiedTerminal — DOM-based terminal surface for per-agent terminal panes.
 *
 * Consumes the normalized `agentOutputStore` stream (ANSI stripped, provider
 * adapter applied, blanks and spinner frames collapsed) and renders it as a
 * scrollable line log. A single Vercel-style composer at the bottom of the pane
 * is the primary chat/input control.
 *
 * Performance notes:
 * - The visible line list is virtualized with @tanstack/react-virtual and
 *   dynamic row-height measurement so a 1,000-line scrollback only creates DOM
 *   nodes for the viewport plus overscan.
 * - Footer metadata (line count, thinking count, live-thinking state) is
 *   computed from a debounced snapshot so bursts of PTY output do not recompute
 *   derived state every frame.
 * - Auto-scroll uses requestAnimationFrame and only fires when the user is
 *   already near the bottom.
 * - Plain-text paste uses the browser's native `paste` event to avoid a
 *   blocking main-process clipboard round-trip.
 */

import { useEffect, useRef, useState, useCallback, useMemo, useId } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { ChevronDown, Send, X } from 'lucide-react';
import { useAgentOutputStore, type AgentOutputLine } from '../../stores/agentOutputStore';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStatusStore } from '../../stores/agentStatusStore';
import { useAcpSessionStore } from '../../stores/acpSessionStore';
import type { AcpSendContentBlock } from '@shared/acpTypes';
import { ThinkingBlock } from '../ThinkingBlock';
import { TerminalFooter } from './TerminalFooter';
import { CodeChangeCard } from './CodeChangeCard';
import { terminalStreamNormalizer } from '../../lib/terminalStream';
import { useTerminalImages, type StagedImage } from '../../hooks/useTerminalImages';
import { useInputHistory } from '../../hooks/useInputHistory';

import { perfMark, perfMeasure } from '../../lib/perf';
import { trackEvent } from '../../lib/telemetry';
import { AcpTranscript } from '../AcpTranscript';

export interface UnifiedTerminalProps {
  /** Agent whose output stream to render. */
  agentName?: string;
  /** Full agent state (preferred). */
  agent?: import('@shared/types').AgentState;
  /** Active PTY terminal id for this agent. Undefined when the agent is offline. */
  terminalId?: string;
  /** Pane is the actively focused terminal. */
  isFocused?: boolean;
  /** Optional compact font size (sidebar mode). */
  compact?: boolean;
  /** Called when the user focuses the terminal surface or composer. */
  onFocus?: () => void;
  /** Called when the live-thinking state changes so the parent can sync status. */
  onThinkingLiveChange?: (isThinkingLive: boolean) => void;
}

export const MIN_COLS = 10;
export const MIN_ROWS = 4;

const SAMPLE_CHARS = 'MMMMMMMMMM';
const AUTO_SCROLL_THRESHOLD_PX = 40;
const FOOTER_DEBOUNCE_MS = 100;
const PASTE_COLLAPSE_LINE_THRESHOLD = 5;
const PASTE_COLLAPSE_CHAR_THRESHOLD = 1000;

export function UnifiedTerminal({
  agentName: agentNameProp,
  agent: agentProp,
  terminalId,
  isFocused,
  compact,
  onFocus,
  onThinkingLiveChange,
}: UnifiedTerminalProps) {
  const agent = agentProp ?? null;
  const agentName = agent?.name ?? agentNameProp ?? '';
  // Narrow selector: only subscribe to lines for this agent.
  const allLines = useAgentOutputStore((s) => s.lines);
  const filteredLines = useMemo(
    () => allLines.filter((l) => l.agent === agentName),
    [allLines, agentName],
  );
  const showThinking = useAppStore((s) => s.settings.showThinking) !== false;

  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pastedBlockRef = useRef<{ placeholder: string; fullText: string } | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalIdRef = useRef(terminalId);
  const userScrolledRef = useRef(false);
  const rafScrollRef = useRef<number | null>(null);
  terminalIdRef.current = terminalId;

  const [paused, setPaused] = useState(false);
  const [showNewOutput, setShowNewOutput] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingInstantSend, setPendingInstantSend] = useState(false);
  const errorId = useId();

  // Debounced footer metadata so PTY bursts don't recompute stats every frame.
  // Initialize synchronously from the current lines so first render is correct.
  const computeStats = useCallback((lines: AgentOutputLine[]) => {
    const lineCount = lines.length;
    const thinkingCount = lines.filter((l) => l.thinking && !l.thinkingLive).length;
    const isThinkingLive = lines.length > 0 && !!lines[lines.length - 1].thinkingLive;
    return { lineCount, thinkingCount, isThinkingLive };
  }, []);

  const [debouncedStats, setDebouncedStats] = useState(() => computeStats(filteredLines));

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedStats(computeStats(filteredLines));
    }, FOOTER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filteredLines, computeStats]);

  const { lineCount, thinkingCount, isThinkingLive } = debouncedStats;
  const activeProject = useProjectStore((s) => s.activeProject);
  const repoPath = activeProject?.repo_path ?? '';
  // runtime_choice is the single authority for the team runtime; agent.provider
  // may be stale from the legacy agentProvider field.
  const effectiveProvider = activeProject?.runtime_choice ?? agent?.provider ?? null;
  const instantSendPastedImages = useAppStore((s) => s.settings.instantSendPastedImages) === true;
  const enableTerminalImagePaste = useAppStore((s) => s.settings.enableTerminalImagePaste) !== false;
  const agentStatus = useAgentStatusStore((s) => s.statuses[agentName]);
  const contextUsage = agentStatus?.contextUsage ?? 0;
  const acpSession = useAcpSessionStore((s) => s.sessions.get(agentName));
  // ACP transcript is authoritative once the session has been initialized
  // (sessionId assigned by the runtime). Until then, fall back to the PTY/bridge
  // surface so the pane never shows a stale or mixed stream.
  const isAcpMode = !!acpSession?.sessionId;
  const sessionKey = isAcpMode ? (acpSession?.sessionId ?? '') : (terminalId ?? '');
  const inputHistory = useInputHistory(agentName, sessionKey || undefined);

  const acpActiveTurn = isAcpMode
    ? (acpSession?.turns.find((t) => t.id === acpSession?.activeTurnId) ?? null)
    : null;
  const acpIsThinkingLive = acpActiveTurn?.status === 'thinking';
  const footerLineCount = isAcpMode ? (acpSession?.turns.length ?? 0) : lineCount;
  const footerThinkingCount = isAcpMode ? 0 : thinkingCount;

  const computeDimensions = useCallback(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    const scroll = scrollRef.current;
    if (!container || !measure || !scroll) return { cols: MIN_COLS, rows: MIN_ROWS };

    const rect = measure.getBoundingClientRect();
    const charWidth = rect.width / SAMPLE_CHARS.length;
    const lineHeight = rect.height;
    if (charWidth <= 0 || lineHeight <= 0) return { cols: MIN_COLS, rows: MIN_ROWS };

    // Measure the scroll surface (the actual text box), not the outer host.
    // clientWidth includes padding but excludes the scrollbar; subtract the
    // padding to get the content box the PTY should format for. This keeps the
    // reported cols/rows in sync with where the DOM will wrap, avoiding the
    // "resize is hard" mismatch where the CLI emitted more cols than fit.
    const style = window.getComputedStyle(scroll);
    const paddingHor = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const paddingVer = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

    const availableWidth = Math.max(0, scroll.clientWidth - paddingHor);
    const availableHeight = Math.max(0, scroll.clientHeight - paddingVer);

    const cols = Math.max(MIN_COLS, Math.floor(availableWidth / charWidth));
    const rows = Math.max(MIN_ROWS, Math.floor(availableHeight / lineHeight));

    return { cols, rows };
  }, []);

  const reportDimensions = useCallback(() => {
    const dims = computeDimensions();
    const tid = terminalIdRef.current;
    if (tid && typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.resizeTerminal(tid, dims.cols, dims.rows);
    }
  }, [computeDimensions]);

  // Debounced resize reporting.
  const scheduleReport = useCallback(() => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      reportDimensions();
    }, 100);
  }, [reportDimensions]);

  useEffect(() => {
    const observer = new ResizeObserver(scheduleReport);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    // Initial report after layout settles.
    let rafHandle: number;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = requestAnimationFrame(() => {
        reportDimensions();
      });
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafHandle);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [scheduleReport, reportDimensions]);

  // Re-report dimensions when a new terminal session starts.
  useEffect(() => {
    if (terminalId) {
      const t = setTimeout(() => reportDimensions(), 0);
      return () => clearTimeout(t);
    }
  }, [terminalId, reportDimensions]);

  // Virtualize the line list. Dynamic row heights handle wrapped lines.
  const virtualizer = useVirtualizer({
    count: filteredLines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 5,
    getItemKey: (index) => filteredLines[index]?.id ?? `fallback-${index}`,
  });

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  // Determine whether the user is currently near the bottom.
  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD_PX;
  }, []);

  // Auto-scroll to bottom when new lines arrive, unless paused or user scrolled up.
  useEffect(() => {
    if (paused) {
      setShowNewOutput(true);
      return;
    }
    if (rafScrollRef.current) cancelAnimationFrame(rafScrollRef.current);
    rafScrollRef.current = requestAnimationFrame(() => {
      rafScrollRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      const nearBottom = userScrolledRef.current ? isNearBottom() : true;
      if (nearBottom) {
        virtualizer.scrollToIndex(filteredLines.length - 1, { align: 'end', behavior: 'auto' });
        setShowNewOutput(false);
        userScrolledRef.current = false;
      } else {
        setShowNewOutput(true);
      }
    });
    return () => {
      if (rafScrollRef.current) {
        cancelAnimationFrame(rafScrollRef.current);
        rafScrollRef.current = null;
      }
    };
  }, [filteredLines.length, paused, virtualizer, isNearBottom]);

  // Track scroll position to pause/resume automatically.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    userScrolledRef.current = true;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD_PX;
    if (nearBottom && paused) {
      setPaused(false);
      setShowNewOutput(false);
    } else if (!nearBottom && !paused) {
      setPaused(true);
    }
  }, [paused]);

  // Focus the composer when this pane becomes focused.
  useEffect(() => {
    if (isFocused) {
      inputRef.current?.focus();
    }
  }, [isFocused]);

  // Notify the parent when live-thinking state changes so the header status
  // pill can stay in sync with the footer. In ACP mode the authority is the
  // active turn status, not the PTY line stream.
  useEffect(() => {
    onThinkingLiveChange?.(isAcpMode ? acpIsThinkingLive : isThinkingLive);
  }, [isAcpMode, acpIsThinkingLive, isThinkingLive, onThinkingLiveChange]);

  const getSelectionText = useCallback((): string => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return '';
    return selection.toString();
  }, []);

  const handleCopy = useCallback(() => {
    const text = getSelectionText();
    if (text) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }, [getSelectionText]);

  const writePastedText = useCallback(async (text: string) => {
    const tid = terminalIdRef.current;
    if (!tid || !text) return;
    const start = perfMark('terminal-paste');
    window.electronAPI.writeTerminal(tid, text);
    perfMeasure('terminal-paste', start, { length: text.length });
  }, []);

  // Native paste path for the terminal surface — avoids the main-process
  // clipboard round-trip on the critical input path.
  const handleTerminalPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (e.defaultPrevented) return;
      // Only handle pastes that actually landed on the scroll surface or its
      // children. Events from the composer input must not be rerouted to the
      // PTY (where ACP sessions silently no-op).
      const target = e.target as Node | null;
      if (!target || !scrollRef.current || !scrollRef.current.contains(target)) return;
      const tid = terminalIdRef.current;
      if (!tid) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (text) {
        e.preventDefault();
        writePastedText(text);
      }
    },
    [writePastedText],
  );

  // Fallback paste path used by the context-menu handler.
  const handlePasteFallback = useCallback(async () => {
    const tid = terminalIdRef.current;
    if (!tid) return;
    try {
      const text = await window.electronAPI.readClipboardText();
      if (text) {
        writePastedText(text);
      }
    } catch (err) {
      console.warn(`[UnifiedTerminal ${agentName}] paste fallback failed:`, err);
    }
  }, [agentName, writePastedText]);

  const handleContextMenuPaste = useCallback(async () => {
    // Prefer the native paste path so images from the clipboard land in the
    // composer input and are staged exactly like Ctrl+V. Focus the input first
    // so webContents.paste() targets it.
    inputRef.current?.focus();
    try {
      await window.electronAPI.triggerPaste();
    } catch (err) {
      console.warn(`[UnifiedTerminal ${agentName}] context-menu paste failed:`, err);
      // Fallback for plain text: read the OS clipboard and write it to the PTY.
      await handlePasteFallback();
    }
  }, [agentName, handlePasteFallback]);

  const insertTextAtCursor = useCallback((input: HTMLInputElement, text: string) => {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const lineCount = text.split('\n').length;
    const shouldCollapse =
      lineCount >= PASTE_COLLAPSE_LINE_THRESHOLD || text.length >= PASTE_COLLAPSE_CHAR_THRESHOLD;

    const mark = perfMark('composer-insert-text');

    if (shouldCollapse) {
      // Large code/text pastes get collapsed into a placeholder so the single-line
      // composer doesn't render hundreds of lines. The full text is preserved and
      // sent as the actual message when the user hits Enter.
      const placeholder = `[pasted code ${lineCount} lines]`;
      pastedBlockRef.current = { placeholder, fullText: text };
      input.value = placeholder;
    } else if (typeof input.setRangeText === 'function') {
      // Use the native setRangeText API when available: it performs the splice
      // and selection update in one optimized browser operation, avoiding the
      // O(n) string copies that happen when we slice and concatenate manually.
      // This makes pasting small-to-medium prompts into the composer feel instant.
      input.setRangeText(text, start, end, 'end');
    } else {
      const newValue = input.value.slice(0, start) + text + input.value.slice(end);
      input.value = newValue;
      const newCursor = start + text.length;
      input.setSelectionRange(newCursor, newCursor);
    }

    input.focus();
    perfMeasure('composer-insert-text', mark, { length: text.length, collapsed: shouldCollapse });
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const selection = getSelectionText();
      const items: { label: string; action: () => void }[] = [];
      if (selection) {
        items.push({ label: 'Copy', action: handleCopy });
      }
      if (terminalIdRef.current) {
        items.push({ label: 'Paste', action: handleContextMenuPaste });
      }
      if (items.length === 0) return;

      const menu = document.createElement('div');
      menu.className =
        'fixed z-50 bg-slate-800 border border-slate-700 rounded shadow-lg py-1 text-xs text-slate-200';
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      items.forEach((item) => {
        const btn = document.createElement('button');
        btn.className = 'block w-full text-left px-3 py-1 hover:bg-slate-700';
        btn.textContent = item.label;
        btn.onclick = () => {
          item.action();
          if (menu.parentNode) document.body.removeChild(menu);
        };
        menu.appendChild(btn);
      });
      document.body.appendChild(menu);
      requestAnimationFrame(() => {
        document.addEventListener('click', () => {
          if (menu.parentNode) document.body.removeChild(menu);
        }, { once: true });
      });
    },
    [handleCopy, handleContextMenuPaste, getSelectionText],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isAcpMode) return;
      const tid = terminalIdRef.current;
      if (!tid) return;

      // Ctrl+C: copy if there is a selection, otherwise send SIGINT.
      if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
        const selection = getSelectionText();
        if (selection) {
          e.preventDefault();
          handleCopy();
        } else {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\u0003');
        }
        return;
      }

      // Ctrl+V is now handled by the native paste event on the scroll surface.

      // Forward a few useful control sequences.
      if (e.key.length > 1) {
        if (e.key === 'Enter') {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\r');
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\u007f');
        } else if (e.key === 'Tab') {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\t');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\u001b');
        }
        return;
      }

      // Printable keystrokes.
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        window.electronAPI.writeTerminal(tid, e.key);
      }
    },
    [getSelectionText, handleCopy, isAcpMode],
  );

  const { images: stagedImages, error: imageError, addImageFromFile, removeImage, clearImages } = useTerminalImages();

  // Return focus to the composer after removing a preview so keyboard users stay
  // in the input flow (PRD §9 accessibility).
  const handleRemoveImage = useCallback(
    (id: string) => {
      removeImage(id);
      inputRef.current?.focus();
    },
    [removeImage],
  );

  // Image paste/send is only supported in ACP mode now that the legacy PTY
  // temp-file image path has been removed from the main process.
  const canSendImages = isAcpMode;

  const sendInputLine = useCallback(() => {
    const tid = terminalIdRef.current;
    const input = inputRef.current;
    if (!input) return;
    // If the composer is showing a collapsed paste placeholder, send the stored
    // full text instead of the placeholder.
    const value = pastedBlockRef.current?.fullText ?? input.value;
    setSendError(null);

    if (isAcpMode) {
      // If a previous assistant turn is still active, fail it before the user
      // starts a new turn. Otherwise the old turn's spinner stays live forever
      // when the new assistant turn takes over activeTurnId.
      if (useAcpSessionStore.getState().getSession(agentName)?.activeTurnId) {
        useAcpSessionStore.getState().failActiveTurn(agentName, 'Interrupted by new message');
      }

      const sessionId = acpSession?.sessionId ?? '';
      const imagesToSend = stagedImages.map((img) => ({
        id: img.id,
        name: img.name,
        type: img.type,
        data: img.data,
      }));
      const totalSizeBytes = stagedImages.reduce((sum, img) => sum + img.size, 0);

      if (!value && imagesToSend.length === 0) return;

      useAcpSessionStore.getState().startUserTurn(agentName, sessionId, value, imagesToSend);
      useAcpSessionStore.getState().startAssistantTurn(agentName, sessionId);

      // No images: keep the original synchronous clear behavior for ACP text prompts.
      if (imagesToSend.length === 0) {
        window.electronAPI
          .sendAcpPrompt({ agent: agentName, sessionId, text: value })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : 'Failed to send message.';
            setSendError(message);
            useAcpSessionStore.getState().failActiveTurn(agentName, message);
          });
        inputHistory.commit(value);
        input.value = '';
        pastedBlockRef.current = null;
        return;
      }

      // Build the flat send content blocks expected by AcpSendMessagePayload.
      // The store turn keeps the canonical nested AcpContentBlock shape; the
      // IPC contract to the main process is flat AcpSendContentBlock[].
      const contentBlocks = buildAcpSendBlocks(value, imagesToSend);

      const sendPromise = window.electronAPI.sendAcpMessage({ agent: agentName, sessionId, content: contentBlocks });

      sendPromise
        .then(() => {
          inputHistory.commit(value);
          input.value = '';
          pastedBlockRef.current = null;
          clearImages();
          trackEvent({ event: 'image_paste_sent', imageCount: imagesToSend.length, totalSizeBytes });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Failed to send message.';
          setSendError(message);
          useAcpSessionStore.getState().failActiveTurn(agentName, message);
          trackEvent({ event: 'image_paste_failed', errorCode: 'IPC_ERROR' });
        });
      return;
    }

    if (!tid) return;

    if (stagedImages.length > 0) {
      if (!canSendImages) {
        setSendError('Image input is only supported in ACP mode.');
        trackEvent({ event: 'image_paste_failed', errorCode: 'UNSUPPORTED_PROVIDER' });
        return;
      }
      // PTY image send was removed with the legacy temp-file path. ACP mode
      // handles images earlier in this function, so this branch is unreachable.
      return;
    }

    if (!value) return;
    const ts = new Date().toISOString();
    useAgentOutputStore.getState().addLine({ agent: agentName, terminal_id: tid, line: value, source: 'user', ts });
    terminalStreamNormalizer.suppressEcho(tid, value);
    window.electronAPI.writeTerminal(tid, value + '\r');
    inputHistory.commit(value);
    input.value = '';
    pastedBlockRef.current = null;
  }, [stagedImages, canSendImages, clearImages, effectiveProvider, isAcpMode, acpSession, agentName, inputHistory]);

  // Phase 2 instant-send: once images are staged and the composer is still
  // empty, send the message automatically. Use a ref for the callback so the
  // effect does not re-fire when sendInputLine is recreated by ACP store
  // updates inside the send path.
  const sendInputLineRef = useRef(sendInputLine);
  sendInputLineRef.current = sendInputLine;

  useEffect(() => {
    if (!pendingInstantSend) return;
    setPendingInstantSend(false);
    const input = inputRef.current;
    if (!input || input.value !== '') return;
    if (stagedImages.length === 0) return;
    sendInputLineRef.current();
  }, [pendingInstantSend, stagedImages.length]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const tid = terminalIdRef.current;

      if (e.key === 'Enter') {
        e.preventDefault();
        sendInputLine();
        return;
      }

      // If a collapsed paste placeholder is active, don't let the user edit the
      // placeholder text. Backspace/Delete clears it fully; a printable key
      // clears it before the character is inserted; other keys pass through.
      if (pastedBlockRef.current) {
        const input = e.currentTarget;
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          pastedBlockRef.current = null;
          input.value = '';
          return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          pastedBlockRef.current = null;
          input.value = '';
        }
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const input = inputRef.current;
        if (!input) return;
        // Discard any collapsed paste block before recalling history so the
        // stored full text doesn't override the recalled item on send.
        pastedBlockRef.current = null;
        const next = inputHistory.cycle(e.key === 'ArrowUp' ? 'up' : 'down', input.value);
        if (next !== null) {
          input.value = next;
          requestAnimationFrame(() => {
            input.setSelectionRange(next.length, next.length);
          });
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (pastedBlockRef.current) {
          pastedBlockRef.current = null;
          e.currentTarget.value = '';
        } else if (stagedImages.length > 0) {
          clearImages();
          setSendError(null);
        } else if (!isAcpMode && tid) {
          window.electronAPI.writeTerminal(tid, '\u001b');
        }
        return;
      }

      if (e.key === 'Tab') {
        if (!isAcpMode && tid) {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\t');
        }
        return;
      }

      // Ctrl+C: SIGINT if no selection, otherwise let default copy handle it.
      if (e.key.toLowerCase() === 'c' && (e.ctrlKey || e.metaKey)) {
        const input = e.currentTarget;
        if (input.selectionStart === input.selectionEnd) {
          e.preventDefault();
          if (isAcpMode) {
            const sessionId = acpSession?.sessionId ?? '';
            window.electronAPI.sendAcpCancel({ agent: agentName, sessionId });
          } else if (tid) {
            window.electronAPI.writeTerminal(tid, '\u0003');
          }
          input.value = '';
          pastedBlockRef.current = null;
        }
        return;
      }

    },
    [sendInputLine, stagedImages, clearImages, isAcpMode, acpSession, agentName, inputHistory],
  );

  const handleInputPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLInputElement>) => {
      const input = e.currentTarget;
      const items = Array.from(e.clipboardData?.items ?? []);
      const files = Array.from(e.clipboardData?.files ?? []);
      let imageHandled = false;
      let textHandled = false;
      const composerWasEmpty = input.value === '';
      const pasteMark = perfMark('composer-paste');

      // Insert plain text first so the composer stays responsive even when the
      // clipboard also contains images that need async staging/decoding.
      // Prefer the synchronous getData API for the common case; only fall back
      // to the callback-based items API when getData is empty.
      const plainText = e.clipboardData?.getData('text/plain') ?? '';
      if (plainText) {
        textHandled = true;
        insertTextAtCursor(input, plainText);
      } else {
        for (const item of items) {
          if (item.kind === 'string' && item.type === 'text/plain') {
            textHandled = true;
            item.getAsString((text) => {
              insertTextAtCursor(input, text);
            });
          }
        }
      }

      // Stage images after text so the composer stays responsive. Keep the
      // sequential await so the max-images check inside useTerminalImages is
      // evaluated against the latest state for each file.
      if (enableTerminalImagePaste) {
        // Prefer the files list (standard API) and fall back to items for
        // environments where only items are populated (e.g. some jsdom setups).
        if (files.length > 0) {
          for (const file of files) {
            if (file.type.startsWith('image/')) {
              imageHandled = true;
              await addImageFromFile(file);
            }
          }
        } else {
          for (const item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
              const file = item.getAsFile();
              if (file) {
                imageHandled = true;
                await addImageFromFile(file);
              }
            }
          }
        }
      }

      if (imageHandled || textHandled) {
        e.preventDefault();
        e.stopPropagation();
      }

      perfMeasure('composer-paste', pasteMark, {
        text: textHandled,
        images: imageHandled,
        length: input.value.length,
      });

      // Phase 2 instant-send: only when the composer was empty, no text was
      // pasted, and the input is still empty after staging images. Mixed
      // clipboards always wait for Enter so the user can add context.
      if (composerWasEmpty && instantSendPastedImages && !textHandled && input.value === '') {
        setPendingInstantSend(true);
      }
    },
    [addImageFromFile, insertTextAtCursor, instantSendPastedImages, enableTerminalImagePaste],
  );

  const handleClick = useCallback(() => {
    onFocus?.();
    // Don't steal focus while the user is selecting text to copy.
    const selection = window.getSelection();
    if (!selection || selection.toString().length === 0) {
      inputRef.current?.focus();
    }
  }, [onFocus]);

  const handleInputInput = useCallback((e: React.FormEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    if (pastedBlockRef.current && input.value !== pastedBlockRef.current.placeholder) {
      pastedBlockRef.current = null;
    }
  }, []);

  const resumeFollow = useCallback(() => {
    setPaused(false);
    setShowNewOutput(false);
    userScrolledRef.current = false;
    // Scroll the actual scroll container to the bottom. This works for both
    // the PTY virtualized list and the ACP transcript, whereas
    // virtualizer.scrollToIndex only targets the PTY line list and does
    // nothing when the ACP transcript is rendered.
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div
        ref={containerRef}
        data-testid="terminal-host"
        className="relative flex-1 min-h-0 overflow-hidden bg-acp-bg"
        onClick={handleClick}
      >
        {/* Hidden measurement span for dimension math. */}
        <span
          ref={measureRef}
          data-testid="terminal-measure"
          aria-hidden="true"
          className={`absolute -left-[9999px] top-0 font-terminal whitespace-pre pointer-events-none select-none ${
            compact ? 'text-[11px] leading-normal' : 'text-[13px] leading-normal'
          }`}
        >
          {SAMPLE_CHARS}
        </span>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onContextMenu={handleContextMenu}
          onKeyDown={handleKeyDown}
          onPaste={handleTerminalPaste}
          className={`h-full w-full overflow-y-auto ${isAcpMode ? 'overflow-x-hidden' : 'overflow-x-auto'} outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-500/50 font-terminal ${
            compact ? 'text-[11px]' : 'text-[13px]'
          } p-2`}
          role="log"
          aria-live="polite"
          aria-label={`Terminal output for ${agentName}`}
          tabIndex={0}
        >
          {isAcpMode ? (
            <AcpTranscript
              turns={acpSession?.turns ?? []}
              activeTurnId={acpSession?.activeTurnId ?? null}
              agent={agentName}
              sessionId={acpSession?.sessionId}
              pendingPermission={acpSession?.pendingPermission}
            />
          ) : (
            <>
              {filteredLines.length === 0 && !terminalId && (
                <div className="h-full flex items-center justify-center text-slate-500 select-none">
                  Terminal output will appear here.
                </div>
              )}

              {filteredLines.length > 0 && (
                <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
                  {virtualItems.map((virtualItem) => {
                    const line = filteredLines[virtualItem.index];
                    return (
                      <div
                        key={virtualItem.key}
                        data-index={virtualItem.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                      >
                        <TerminalLine
                          line={line}
                          compact={compact}
                          showThinking={showThinking}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {showNewOutput && paused && (
          <button
            onClick={resumeFollow}
            className="absolute bottom-4 right-4 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 shadow-lg cursor-pointer"
          >
            <ChevronDown className="w-3.5 h-3.5" />
            New output
          </button>
        )}

        {!terminalId && filteredLines.length > 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-slate-500 select-none bg-slate-900/80">
            Session ended.
          </div>
        )}
      </div>

      {/* Footer context bar — metadata above the input */}
      {agent && (
        <TerminalFooter
          agent={agent}
          provider={effectiveProvider}
          repoPath={repoPath}
          lineCount={footerLineCount}
          thinkingCount={footerThinkingCount}
          contextUsage={contextUsage}
        />
      )}

      {/* Vercel-style composer — single chat input for the pane */}
      <div className="shrink-0 border-t border-slate-800 bg-slate-900 p-2 space-y-2">
        {/* Image preview strip */}
        {stagedImages.length > 0 && (
          <div
            className="flex gap-2 overflow-x-auto pb-1"
            data-testid="terminal-image-previews"
            role="list"
            aria-label={`${stagedImages.length} pasted image${stagedImages.length === 1 ? '' : 's'}`}
          >
            {stagedImages.map((img, idx) => (
              <ImagePreviewChip
                key={img.id}
                image={img}
                index={idx}
                onRemove={handleRemoveImage}
              />
            ))}
          </div>
        )}

        {/* Validation / send errors */}
        {(imageError || sendError) && (
          <div
            id={errorId}
            className="text-xs text-red-400 px-1"
            data-testid="terminal-image-error"
          >
            {imageError ?? sendError}
          </div>
        )}

        {/* ACP-only notice */}
        {terminalId && stagedImages.length > 0 && !canSendImages && (
          <div className="text-xs text-amber-400 px-1" data-testid="terminal-acp-only">
            Image paste is only supported in ACP mode.
          </div>
        )}

        <div className="flex items-center gap-2 rounded-full bg-slate-800/80 px-3 py-2 border border-slate-700/50 focus-within:border-slate-500 focus-within:ring-1 focus-within:ring-slate-500/30 transition-all">
          <input
            ref={inputRef}
            type="text"
            defaultValue=""
            onKeyDown={handleInputKeyDown}
            onInput={handleInputInput}
            onPaste={handleInputPaste}
            onFocus={onFocus}
            disabled={!terminalId}
            placeholder={terminalId ? `Message ${agentName}…` : 'Start the agent to type…'}
            className="flex-1 bg-transparent text-slate-200 text-sm font-sans placeholder:text-slate-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="terminal-input"
            aria-label="Terminal message input"
            aria-describedby={imageError || sendError ? errorId : undefined}
          />
          <button
            onClick={sendInputLine}
            disabled={!terminalId || (stagedImages.length > 0 && !canSendImages)}
            className="p-1.5 rounded-full text-slate-400 hover:text-emerald-400 hover:bg-slate-700/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Send"
            data-testid="terminal-send"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

interface TerminalLineProps {
  line: AgentOutputLine;
  compact?: boolean;
  showThinking: boolean;
}

const LIST_MARKER = /^(\s*)(?:[•\-*]|\d{1,2}\.)\s/;

function TerminalLine({ line, compact, showThinking }: TerminalLineProps) {
  // Live thinking placeholders are updated in-place by the store and
  // surfaced as a single-line indicator in the footer. They do not render as
  // repeated blocks inside the stream.
  if (line.thinkingLive) {
    return null;
  }
  if (line.codeChange) {
    return (
      <div className="px-1 -mx-1 py-0.5">
        <CodeChangeCard codeChange={line.codeChange} compact={compact} />
      </div>
    );
  }
  const isUser = line.source === 'user';
  const isInfo = line.source === 'info';
  const isListItem = LIST_MARKER.test(line.line);

  if (isUser) {
    return (
      <div className="flex flex-col py-0.5 rounded px-1 -mx-1 items-end hover:bg-slate-800/30">
        <div className="flex items-start gap-2 max-w-[90%] justify-end">
          <span className="min-w-0 whitespace-pre-wrap break-words leading-normal rounded px-2 py-1 font-terminal bg-blue-600/25 text-blue-100">
            {line.line}
          </span>
        </div>
        {showThinking && line.thinking && (
          <div className="mr-0 mt-0.5">
            <ThinkingBlock label="Thinking…" content={line.thinking} live={false} compact={compact} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col py-0.5 px-1 -mx-1 ${
        isInfo ? 'opacity-70' : ''
      } hover:bg-slate-800/30`}
    >
      <span
        className={`min-w-0 whitespace-pre-wrap leading-normal font-terminal overflow-x-auto ${
          isInfo
            ? 'text-slate-400 italic text-xs'
            : isListItem
              ? 'text-slate-300 pl-1'
              : 'text-slate-300'
        }`}
      >
        {line.line}
      </span>
      {showThinking && line.thinking && (
        <div className="ml-2 mt-0.5">
          <ThinkingBlock label="Thinking…" content={line.thinking} live={false} compact={compact} />
        </div>
      )}
    </div>
  );
}

interface ImagePreviewChipProps {
  image: StagedImage;
  index: number;
  onRemove: (id: string) => void;
}

function ImagePreviewChip({ image, index, onRemove }: ImagePreviewChipProps) {
  return (
    <div className="relative shrink-0 group rounded-lg border border-slate-700 bg-slate-800 overflow-hidden" role="listitem">
      <img
        src={image.previewUrl}
        alt="Pasted image"
        className="w-16 h-16 object-cover"
      />
      <div className="absolute inset-x-0 bottom-0 bg-slate-900/80 px-1.5 py-0.5 text-[10px] text-slate-300 truncate">
        {image.width}×{image.height} · {formatBytes(image.size)}
      </div>
      <button
        type="button"
        onClick={() => onRemove(image.id)}
        className="absolute top-0.5 right-0.5 p-0.5 rounded bg-slate-900/80 text-slate-400 hover:text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        aria-label={`Remove pasted image ${index + 1}`}
        title="Remove"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function buildAcpSendBlocks(
  text: string,
  images: Array<{ type: string; data: ArrayBuffer }>,
): AcpSendContentBlock[] {
  const blocks: AcpSendContentBlock[] = [];
  if (text) {
    blocks.push({ type: 'text', text });
  }
  for (const img of images) {
    blocks.push({ type: 'image', data: arrayBufferToBase64(img.data), mimeType: img.type });
  }
  return blocks;
}
