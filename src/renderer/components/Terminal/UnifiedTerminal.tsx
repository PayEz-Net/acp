/**
 * UnifiedTerminal — DOM-based terminal surface for per-agent terminal panes.
 *
 * Consumes the normalized `agentOutputStore` stream (ANSI stripped, provider
 * adapter applied, blanks and spinner frames collapsed) and renders it as a
 * scrollable line log. A single Vercel-style composer at the bottom of the pane
 * is the primary chat/input control.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { ChevronDown, Send } from 'lucide-react';
import { useAgentOutputStore } from '../../stores/agentOutputStore';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStatusStore } from '../../stores/agentStatusStore';
import { ThinkingBlock } from '../ThinkingBlock';
import { TerminalFooter } from './TerminalFooter';

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
}

export const MIN_COLS = 10;
export const MIN_ROWS = 4;

const SAMPLE_CHARS = 'MMMMMMMMMM';

export function UnifiedTerminal({
  agentName: agentNameProp,
  agent: agentProp,
  terminalId,
  isFocused,
  compact,
  onFocus,
}: UnifiedTerminalProps) {
  const agent = agentProp ?? null;
  const agentName = agent?.name ?? agentNameProp ?? '';
  const lines = useAgentOutputStore((s) => s.lines);
  const showThinking = useAppStore((s) => s.settings.showThinking) !== false;
  const filteredLines = useMemo(() => lines.filter((l) => l.agent === agentName), [lines, agentName]);

  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;

  const [paused, setPaused] = useState(false);
  const [showNewOutput, setShowNewOutput] = useState(false);

  // Per-session output stats for the footer.
  const lineCount = filteredLines.length;
  const thinkingCount = filteredLines.filter((l) => l.thinking && !l.thinkingLive).length;
  const isThinkingLive = filteredLines.length > 0 && !!filteredLines[filteredLines.length - 1].thinkingLive;
  const activeProject = useProjectStore((s) => s.activeProject);
  const repoPath = activeProject?.repo_path ?? '';
  const agentStatus = useAgentStatusStore((s) => s.statuses[agentName]);
  const contextUsage = agentStatus?.contextUsage ?? 0;

  const computeDimensions = useCallback(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return { cols: MIN_COLS, rows: MIN_ROWS };

    const rect = measure.getBoundingClientRect();
    const charWidth = rect.width / SAMPLE_CHARS.length;
    const lineHeight = rect.height;
    if (charWidth <= 0 || lineHeight <= 0) return { cols: MIN_COLS, rows: MIN_ROWS };

    const style = window.getComputedStyle(container);
    const paddingHor = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const paddingVer = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

    const availableWidth = Math.max(0, container.clientWidth - paddingHor);
    const availableHeight = Math.max(0, container.clientHeight - paddingVer);

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

  // Auto-scroll to bottom when new lines arrive, unless paused.
  useEffect(() => {
    if (paused) {
      setShowNewOutput(true);
      return;
    }
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    setShowNewOutput(false);
  }, [filteredLines, paused]);

  // Track scroll position to pause/resume automatically.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
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

  const handlePaste = useCallback(async () => {
    const tid = terminalIdRef.current;
    if (!tid) return;
    try {
      const text = await window.electronAPI.readClipboardText();
      if (text) {
        window.electronAPI.writeTerminal(tid, text);
      }
    } catch (err) {
      console.warn(`[UnifiedTerminal ${agentName}] paste failed:`, err);
    }
  }, [agentName]);

  const insertClipboardIntoInput = useCallback(async (input: HTMLInputElement) => {
    try {
      const text = await window.electronAPI.readClipboardText();
      if (!text) return;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      const newValue = input.value.slice(0, start) + text + input.value.slice(end);
      input.value = newValue;
      const newCursor = start + text.length;
      requestAnimationFrame(() => {
        input.setSelectionRange(newCursor, newCursor);
        input.focus();
      });
    } catch (err) {
      console.warn(`[UnifiedTerminal ${agentName}] input paste failed:`, err);
    }
  }, [agentName]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const selection = getSelectionText();
      const items: { label: string; action: () => void }[] = [];
      if (selection) {
        items.push({ label: 'Copy', action: handleCopy });
      }
      if (terminalIdRef.current) {
        items.push({ label: 'Paste', action: handlePaste });
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
    [handleCopy, handlePaste, getSelectionText],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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

      // Ctrl+V: paste from clipboard.
      if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handlePaste();
        return;
      }

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
    [getSelectionText, handlePaste, handleCopy],
  );

  const sendInputLine = useCallback(() => {
    const tid = terminalIdRef.current;
    const input = inputRef.current;
    if (!tid || !input) return;
    const value = input.value;
    if (!value) return;
    window.electronAPI.writeTerminal(tid, value + '\r');
    input.value = '';
  }, []);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const tid = terminalIdRef.current;
      if (!tid) return;

      if (e.key === 'Enter') {
        e.preventDefault();
        sendInputLine();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        window.electronAPI.writeTerminal(tid, '\u001b');
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        window.electronAPI.writeTerminal(tid, '\t');
        return;
      }

      // Ctrl+C: SIGINT if no selection, otherwise let default copy handle it.
      if (e.key.toLowerCase() === 'c' && (e.ctrlKey || e.metaKey)) {
        const input = e.currentTarget;
        if (input.selectionStart === input.selectionEnd) {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\u0003');
          input.value = '';
        }
        return;
      }

      // Ctrl+V: paste into the composer input at the cursor.
      if (e.key.toLowerCase() === 'v' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        insertClipboardIntoInput(e.currentTarget);
        return;
      }
    },
    [sendInputLine, insertClipboardIntoInput],
  );

  const handleClick = useCallback(() => {
    onFocus?.();
    // Don't steal focus while the user is selecting text to copy.
    const selection = window.getSelection();
    if (!selection || selection.toString().length === 0) {
      inputRef.current?.focus();
    }
  }, [onFocus]);

  const resumeFollow = useCallback(() => {
    setPaused(false);
    setShowNewOutput(false);
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
          className={`absolute -left-[9999px] top-0 font-mono whitespace-pre pointer-events-none select-none ${
            compact ? 'text-[11px] leading-tight' : 'text-[13px] leading-tight'
          }`}
        >
          {SAMPLE_CHARS}
        </span>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onContextMenu={handleContextMenu}
          onKeyDown={handleKeyDown}
          className={`h-full w-full overflow-y-auto overflow-x-hidden outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-500/50 font-mono ${
            compact ? 'text-[11px]' : 'text-[13px]'
          } p-2 space-y-0.5`}
          role="log"
          aria-live="polite"
          aria-label={`Terminal output for ${agentName}`}
          tabIndex={0}
        >
          {filteredLines.length === 0 && !terminalId && (
            <div className="h-full flex items-center justify-center text-slate-500 select-none">
              Terminal output will appear here.
            </div>
          )}

          {filteredLines.map((line, idx) => {
            // Live thinking placeholders are updated in-place by the store and
            // surfaced as a single-line indicator in the footer. They do not
            // render as repeated blocks inside the stream.
            if (line.thinkingLive) {
              return null;
            }
            return (
              <div
                key={`${line.ts}-${idx}`}
                className="flex flex-col py-0.5 hover:bg-slate-800/30 rounded px-1 -mx-1"
              >
                <div className="flex items-start gap-2">
                  <span className="text-slate-300 min-w-0 whitespace-pre-wrap leading-tight [overflow-wrap:anywhere]">
                    {line.line}
                  </span>
                </div>
                {showThinking && line.thinking && (
                  <div className="ml-2 mt-0.5">
                    <ThinkingBlock
                      label="Thinking…"
                      content={line.thinking}
                      live={false}
                      compact={compact}
                    />
                  </div>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
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
          provider={agent.provider ?? null}
          repoPath={repoPath}
          lineCount={lineCount}
          thinkingCount={thinkingCount}
          contextUsage={contextUsage}
          isThinkingLive={isThinkingLive}
        />
      )}

      {/* Vercel-style composer — single chat input for the pane */}
      <div className="shrink-0 border-t border-slate-800 bg-slate-900 p-2">
        <div className="flex items-center gap-2 rounded-full bg-slate-800/80 px-3 py-2 border border-slate-700/50 focus-within:border-slate-500 focus-within:ring-1 focus-within:ring-slate-500/30 transition-all">
          <input
            ref={inputRef}
            type="text"
            defaultValue=""
            onKeyDown={handleInputKeyDown}
            onFocus={onFocus}
            disabled={!terminalId}
            placeholder={terminalId ? `Message ${agentName}…` : 'Start the agent to type…'}
            className="flex-1 bg-transparent text-slate-200 text-sm font-sans placeholder:text-slate-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="terminal-input"
          />
          <button
            onClick={sendInputLine}
            disabled={!terminalId}
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
