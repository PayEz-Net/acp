import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { AgentState } from '@shared/types';
import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { archetypeLabelFor } from '../../lib/agentLabels';
import { Play, Square, RotateCcw, ChevronDown, Lock, Unlock } from 'lucide-react';

interface TerminalPaneProps {
  agent: AgentState;
  isFocused: boolean;
  onFocus: () => void;
  compact?: boolean;
}

// Module-level scroll-pause state — survives Grid ↔ Focus remounts
const scrollPausedMap = new Map<string, boolean>();

export function TerminalPane({ agent, isFocused, onFocus, compact }: TerminalPaneProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Scroll-pause: user scrolls up = pause, scrolls back to bottom = resume. No timers.
  const isScrollPaused = useRef(false);
  const [showScrollPill, setShowScrollPill] = useState(false);
  // Primary scroll-lock control. Default: locked (auto-scroll on).
  // scrollLockedRef mirrors state so effects/callbacks see current value
  // without taking it as a dep (which would re-create the terminal).
  const [scrollLocked, setScrollLocked] = useState(true);
  const scrollLockedRef = useRef(true);
  const { updateAgentStatus, setAgentTerminalId, registerTerminal, unregisterTerminal, backendAvailable } = useAppStore();
  const activeProjectId = useProjectStore((s) => s.activeProject)?.id;

  // ── Single coalesced layout-fit (WO-terminal-focus-viewport rd2) ──────────
  // Every layout change — container resize, compact/font-size flip, focus /
  // maximize — funnels through THIS one debounced handler instead of each
  // firing its own fit()+resizeTerminal(). Overlapping triggers in a single
  // maximize collapse into ONE fit + ONE PTY resize, so cols stop churning and
  // the horizontal reflow stops. Bottom-pin is scrollToBottom ONLY — no CSS
  // flex-end, no ESC[nT scroll-pan (both rammed the input below the fold).
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleFit = useCallback(() => {
    if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
    fitTimerRef.current = setTimeout(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const term = xtermRef.current;
        const fit = fitAddonRef.current;
        if (!term || !fit) return;

        // xterm v5: fit() changes rows → viewport implicitly moves to latest
        // content. Capture lines-from-bottom so we can restore the user's
        // read position when lock is OFF.
        const wasScrolledBack = isScrollPaused.current && !scrollLockedRef.current;
        const linesFromBottom = wasScrolledBack
          ? Math.max(0, term.buffer.active.baseY - term.buffer.active.viewportY)
          : 0;

        try { fit.fit(); } catch { /* container detached mid-transition */ }
        const tid = useAppStore.getState().agents.find(a => a.name === agent.name)?.terminalId;
        if (tid) window.electronAPI.resizeTerminal(tid, term.cols, term.rows);

        if (scrollLockedRef.current) {
          term.scrollToBottom();
        } else if (wasScrolledBack && linesFromBottom > 0) {
          // Restore the user's scroll distance from the bottom after resize
          const newBaseY = term.buffer.active.baseY;
          term.scrollLines(-Math.min(linesFromBottom, newBaseY));
        }
      }));
    }, 120);
  }, [agent.name, agent.id]);

  // Ref so the init effect's ResizeObserver calls the latest scheduleFit
  // without taking it as a dep (which would re-create the terminal).
  const scheduleFitRef = useRef(scheduleFit);
  useEffect(() => { scheduleFitRef.current = scheduleFit; }, [scheduleFit]);

  // Initialize terminal
  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: compact ? 11 : 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      screenReaderMode: false, // Disable hidden textarea that interferes with chat input
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        cursor: '#7c3aed',
        cursorAccent: '#0f172a',
        selectionBackground: '#7c3aed40',
        black: '#1e293b',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#8b5cf6',
        cyan: '#06b6d4',
        white: '#f1f5f9',
        brightBlack: '#475569',
        brightRed: '#f87171',
        brightGreen: '#34d399',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#a78bfa',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(terminalRef.current);
    // Double RAF ensures container has settled in flex layout before measuring
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAddon.fit();
      });
    });

    // Ctrl+C copies when text is selected (else SIGINT falls through to PTY).
    // Ctrl+V / Ctrl+Shift+V: intercept HERE and drive the paste from the
    // clipboard API. The old approach relied solely on a DOM `paste` event
    // on the container — but paste events target xterm's hidden helper-
    // textarea, not the container, so it never fired: Ctrl+V fell through
    // to xterm as a keystroke and sent raw  (SYN) to the PTY with no
    // content (the reported bug). Reading the clipboard + terminal.paste()
    // honors bracketed-paste mode (ESC[200~/201~) when Claude opts in.
    // Returning false swallows the keystroke so no  is emitted.
    // SINGLE paste path — exactly one of these, no DOM `paste` listener.
    // The double-paste came from this key handler AND the browser's native
    // paste (delivered into xterm's helper-textarea) both firing. Fix:
    // e.preventDefault() on the Ctrl+V keydown kills the native paste (no
    // `paste` event, xterm-native can't fire), then we read the clipboard
    // and terminal.paste() ourselves — honors bracketed-paste (ESC[200~/
    // 201~) when Claude opts in. Return false so no raw ^V byte is emitted.
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && !e.shiftKey && e.key === 'c' && terminal.hasSelection()) {
        navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }
      const isPaste = (e.key === 'v' || e.key === 'V') && (e.ctrlKey || e.metaKey);
      if (isPaste) {
        e.preventDefault();
        navigator.clipboard.readText()
          .then((text) => { if (text) xtermRef.current?.paste(text); })
          .catch((err) => console.error('[Terminal] clipboard read failed:', err));
        return false;
      }
      return true;
    });

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Scroll position tracking — onScroll handles state + keyboard scroll snap-back.
    // Wheel scroll is fully handled by the native capture-phase listener above
    // (which drives scrollLines() directly and never reaches here for wheel events).
    terminal.onScroll(() => {
      const atBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      if (!atBottom) {
        if (scrollLockedRef.current) {
          // Locked + non-wheel scroll (keyboard PageUp etc.) — snap back.
          terminal.scrollToBottom();
          return;
        }
        // Unlocked — user reading scrollback; pause auto-scroll
        scrollPausedMap.set(agent.id, true);
        isScrollPaused.current = true;
      } else {
        // Returned to bottom — resume auto-scroll, hide pill
        scrollPausedMap.set(agent.id, false);
        isScrollPaused.current = false;
        setShowScrollPill(false);
      }
    });

    // Register terminal for mail push message injection
    registerTerminal(agent.name, terminal, activeProjectId);

    // Write welcome message based on agent
    const agentFlavor: Record<string, string[]> = {
      BAPert: [
        '\x1b[35m╔══════════════════════════════════════╗\x1b[0m',
        '\x1b[35m║\x1b[0m  \x1b[1;35mBAPert\x1b[0m - Business Analyst          \x1b[35m║\x1b[0m',
        '\x1b[35m║\x1b[0m  Coordinator & Task Manager          \x1b[35m║\x1b[0m',
        '\x1b[35m╚══════════════════════════════════════╝\x1b[0m',
        '',
        '\x1b[90m  "Keeping the team aligned and on track."\x1b[0m',
        '',
      ],
      NextPert: [
        '\x1b[32m╔══════════════════════════════════════╗\x1b[0m',
        '\x1b[32m║\x1b[0m  \x1b[1;32mNextPert\x1b[0m - Frontend Developer      \x1b[32m║\x1b[0m',
        '\x1b[32m║\x1b[0m  React, Next.js, TypeScript          \x1b[32m║\x1b[0m',
        '\x1b[32m╚══════════════════════════════════════╝\x1b[0m',
        '',
        '\x1b[90m  "Building beautiful UIs, one component at a time."\x1b[0m',
        '',
      ],
      DotNetPert: [
        '\x1b[36m╔══════════════════════════════════════╗\x1b[0m',
        '\x1b[36m║\x1b[0m  \x1b[1;36mDotNetPert\x1b[0m - Backend Developer    \x1b[36m║\x1b[0m',
        '\x1b[36m║\x1b[0m  C#, .NET, APIs, Databases           \x1b[36m║\x1b[0m',
        '\x1b[36m╚══════════════════════════════════════╝\x1b[0m',
        '',
        '\x1b[90m  "Solid backends. Reliable APIs. Always."\x1b[0m',
        '',
      ],
      Aurum: [
        '\x1b[38;5;208m╔══════════════════════════════════════╗\x1b[0m',
        '\x1b[38;5;208m║\x1b[0m  \x1b[1;38;5;208mAurum\x1b[0m - Product Seer               \x1b[38;5;208m║\x1b[0m',
        '\x1b[38;5;208m║\x1b[0m  UX Strategy & Human Experience      \x1b[38;5;208m║\x1b[0m',
        '\x1b[38;5;208m╚══════════════════════════════════════╝\x1b[0m',
        '',
        '\x1b[90m  "Less, but sharper."\x1b[0m',
        '',
      ],
      QAPert: [
        '\x1b[33m╔══════════════════════════════════════╗\x1b[0m',
        '\x1b[33m║\x1b[0m  \x1b[1;33mQAPert\x1b[0m - Quality Assurance         \x1b[33m║\x1b[0m',
        '\x1b[33m║\x1b[0m  Code Review & Testing               \x1b[33m║\x1b[0m',
        '\x1b[33m╚══════════════════════════════════════╝\x1b[0m',
        '',
        '\x1b[90m  "If it ships, it works. Period."\x1b[0m',
        '',
      ],
    };

    const flavor = agentFlavor[agent.name] || [
      `\x1b[1m${agent.name}\x1b[0m`,
      '',
    ];
    // Position welcome message at bottom of viewport
    const contentLines = flavor.length + 2;
    const startRow = terminal.rows - contentLines;
    if (startRow > 0) {
      terminal.write(`\x1b[${startRow + 1};1H`);
    }
    flavor.forEach(line => terminal.writeln(line));
    terminal.writeln('\x1b[90m  Press ▷ to start agent...\x1b[0m');
    terminal.writeln('');

    // Container resize → funnel through the single coalesced handler. No
    // inline fit/PTY-resize/scroll-pan here; scheduleFit owns all of it so
    // overlapping triggers in one maximize collapse to a single fit.
    const resizeObserver = new ResizeObserver(() => {
      scheduleFitRef.current();
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
      if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
      unregisterTerminal(agent.name, activeProjectId);
      terminal.dispose();
      xtermRef.current = null;
    };
  }, [agent.name, registerTerminal, unregisterTerminal]);

  // Font size follows compact mode. A font change shifts cols/rows but does
  // NOT resize the container (so the ResizeObserver won't fire) — trigger the
  // shared coalesced fit explicitly. No separate inline resize/scroll-pan.
  useEffect(() => {
    if (!xtermRef.current) return;
    xtermRef.current.options.fontSize = compact ? 11 : 13;
    scheduleFit();
  }, [compact, scheduleFit]);

  // Maximize/restore (focus layout) re-fits via the shared coalesced handler.
  // The ResizeObserver also catches the container size change; scheduleFit
  // collapses both into a single fit so there's no double-resize width churn.
  useEffect(() => {
    scheduleFit();
  }, [isFocused, scheduleFit]);

  // Handle terminal input
  useEffect(() => {
    if (!xtermRef.current || !agent.terminalId) return;

    const terminal = xtermRef.current;
    // Only auto-focus when this terminal is the actively focused agent.
    // Background agents restarting must not steal focus from the user's
    // current typing context (kimi mode focus-fighting bug).
    if (isFocused) {
      terminal.focus();
    }

    // Send keystrokes to PTY
    const dataHandler = terminal.onData((data) => {
      console.log(`[Terminal] ${agent.name} input:`, JSON.stringify(data));
      window.electronAPI.writeTerminal(agent.terminalId!, data);
    });

    return () => {
      dataHandler.dispose();
    };
  }, [agent.terminalId, isFocused]);

  // Reset scroll-lock to default (locked) on every fresh PTY spawn.
  // Component is not unmounted on restart so useState(true) never re-fires —
  // this effect fires whenever a new terminalId is assigned (spawn / restart).
  useEffect(() => {
    if (!agent.terminalId) return;
    setScrollLocked(true);
    scrollLockedRef.current = true;
  }, [agent.terminalId]);

  // Receive PTY output
  useEffect(() => {
    if (!agent.terminalId) return;

    const unsubscribe = window.electronAPI.onTerminalData((data) => {
      if (data.terminalId === agent.terminalId && xtermRef.current) {
        const term = xtermRef.current;
        term.write(data.data);
        if (scrollLockedRef.current) {
          term.scrollToBottom();
        } else {
          // Unlocked — dev is reading scrollback, show pill but don't interrupt
          setShowScrollPill(true);
        }

        // r1: PTY-text status heuristics removed - unreliable, wastes inference.
        // Status is lifecycle-driven only (starting / ready / offline / error).
        // Post-r1: agent self-reports via lifecycle API.
      }
    });

    return () => unsubscribe();
  }, [agent.terminalId]);

  // Handle terminal resize
  useEffect(() => {
    if (!agent.terminalId || !fitAddonRef.current || !xtermRef.current) return;

    const terminal = xtermRef.current;
    window.electronAPI.resizeTerminal(
      agent.terminalId,
      terminal.cols,
      terminal.rows
    );
  }, [agent.terminalId]);

  // Wheel event interception — capture phase, fires before xterm sees the event.
  // Fixes two issues:
  // 1. Locked snap-back: reactive onScroll fights rapid wheel; capture prevents
  //    the viewport from moving at all.
  // 2. Large / focused pane: Claude Code enables xterm mouse-tracking mode, which
  //    causes xterm to forward wheel events to the PTY as mouse sequences instead
  //    of scrolling the viewport. We intercept and drive scrollLines() ourselves.
  useEffect(() => {
    const el = terminalRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      // Take ownership of this event — xterm never sees it.
      e.stopPropagation();
      e.preventDefault();

      const term = xtermRef.current;
      if (!term) return;

      if (scrollLockedRef.current) {
        // Locked: ensure viewport is at the bottom
        term.scrollToBottom();
        return;
      }

      // Unlocked: manually scroll the viewport.
      // deltaMode 1 = line-based (mouse wheel notch), 0 = pixel (trackpad).
      const lines = e.deltaMode === 1
        ? Math.round(e.deltaY)
        : Math.sign(e.deltaY) * 3;
      if (lines !== 0) term.scrollLines(lines);
    };

    el.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []); // bind once on mount — reads refs at call time

  // Toggle scroll lock — button is PRIMARY control (scrollLockedRef keeps effects in sync)
  const toggleScrollLock = useCallback(() => {
    setScrollLocked(prev => {
      const next = !prev;
      scrollLockedRef.current = next;
      // Snap back immediately when re-locking while scrolled up
      if (next) xtermRef.current?.scrollToBottom();
      return next;
    });
  }, []);

  // Start agent — route through acp-api when available, fallback to direct IPC
  const startAgent = useCallback(async () => {
    updateAgentStatus(agent.id, 'starting');
    try {
      let terminalId: string;

      // Project-driven runtime per feedback_project_is_instantiation_not_filter
      // + feedback_runtime_choice_vs_platform_llm. Read activeProject's
      // runtime_choice from the projectStore and thread through both the
      // acp-api lifecycle/spawn path AND the IPC fallback. pty.ts uses
      // this as the per-spawn override before falling back to the global
      // settings.agentProvider. Null/undefined → main process picks global.
      const activeProject = useProjectStore.getState().activeProject;
      const projectRuntime = activeProject?.runtime_choice ?? null;

      // Workspace root = the PROJECT's repo_path, period. The per-agent workDir
      // (agentReconcile's local?.workDir — '' for any picker-added agent, since
      // there's no per-agent editor yet) is deliberately IGNORED: it was pure
      // landmine (empty → main's resolveWorkDir('') → null → WorkDirError →
      // acp-api 500, the "Aurum still no good" bug). One authority: the project.
      const effectiveWorkDir = activeProject?.repo_path || '';

      // a-renderer leg [1]: per-agent Claude effort from the active project's
      // team row. NULL/absent → undefined: OMIT it so pty.ts's resolver applies
      // the single global default; NEVER substitute 'high' here (Aurum 1413).
      // Sent on BOTH manual paths — the lifecycle POST [primary, path-3] AND the
      // IPC fallback [path-1] — per QA 1417/1418.
      const teamMember = (useProjectStore.getState().currentProjectTeam ?? []).find(
        (m) => m.agent_name === agent.name,
      );
      const effortOverride = teamMember?.effort_override ?? undefined;

      if (backendAvailable) {
        // Phase 2: lifecycle via acp-api → callback server → node-pty
        const secret = await window.electronAPI.getLocalSecret();
        const res = await fetch(`http://127.0.0.1:3001/v1/lifecycle/agents/${encodeURIComponent(agent.name)}/spawn`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
            ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify({
            workDir: effectiveWorkDir,
            ...(projectRuntime ? { runtime: projectRuntime } : {}),
            ...(effortOverride ? { effort: effortOverride } : {}),
            // projectId = the stable lookup KEY backoff captures so #16b restart-
            // restore re-resolves effort_override FRESH from the DB on crash/manual
            // restart (DNP 1435 / acp-api 6feb3eb), not a stale cached value.
            ...(activeProject?.id != null ? { projectId: activeProject.id } : {}),
          }),
        });
        const data = await res.json();
        console.log(`[Agent] Spawn response for ${agent.name}:`, res.status, data, projectRuntime ? `runtime: ${projectRuntime}` : '(global runtime)');
        // Extract terminalId — API returns snake_case terminal_id
        const extractId = (d: any) => d?.terminal_id || d?.terminalId;
        // 409 = already running — reattach via acp-api (returns 200 with reattached:true)
        if (!res.ok) {
          throw new Error(data.message || data.error?.message || `Spawn failed: ${res.status}`);
        }
        terminalId = extractId(data.data) || extractId(data);
      } else {
        // Fallback: direct IPC to Electron main
        terminalId = await window.electronAPI.spawnAgent(agent.name, effectiveWorkDir, projectRuntime ?? undefined, activeProject?.id, effortOverride);
      }

      setAgentTerminalId(agent.id, terminalId);
      updateAgentStatus(agent.id, 'ready');
    } catch (err) {
      console.error('Failed to start agent:', err);
      if (xtermRef.current) {
        xtermRef.current.writeln(`\x1b[31mFailed to start: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
      }
      updateAgentStatus(agent.id, 'error');
    }
  }, [agent.id, agent.name, agent.workDir, backendAvailable, updateAgentStatus, setAgentTerminalId]);

  // Stop agent — kill PTY via both lifecycle API and direct IPC
  const stopAgent = useCallback(async () => {
    const tid = agent.terminalId;
    try {
      if (backendAvailable) {
        const secret = await window.electronAPI.getLocalSecret();
        await fetch(`http://127.0.0.1:3001/v1/lifecycle/agents/${encodeURIComponent(agent.name)}/kill`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
            ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
          },
        }).catch(() => {});
      }
      // Always direct-kill as backstop
      if (tid) window.electronAPI.killTerminal(tid);
    } catch (err) {
      console.error('Failed to stop agent:', err);
      if (tid) window.electronAPI.killTerminal(tid);
    }
    // Clear terminal and reset state
    if (xtermRef.current) {
      xtermRef.current.clear();
      xtermRef.current.writeln('\x1b[90mAgent stopped.\x1b[0m');
    }
    setAgentTerminalId(agent.id, undefined as any);
    updateAgentStatus(agent.id, 'offline');
  }, [agent.id, agent.name, agent.terminalId, backendAvailable, updateAgentStatus, setAgentTerminalId]);

  // Restart agent — stop then start fresh
  const restartAgent = useCallback(async () => {
    await stopAgent();
    // Brief delay for PTY cleanup
    await new Promise(r => setTimeout(r, 500));
    await startAgent();
  }, [stopAgent, startAgent]);

  // Auto-start if configured
  useEffect(() => {
    if (agent.autoStart && agent.status === 'offline' && !agent.terminalId) {
      startAgent();
    }
  }, [agent.autoStart, agent.status, agent.terminalId, startAgent]);

  const statusColors: Record<string, string> = {
    offline: 'bg-slate-500',
    starting: 'bg-purple-500 animate-pulse',
    ready: 'bg-blue-500',
    busy: 'bg-amber-500 animate-pulse',
    idle: 'bg-green-500',
    error: 'bg-red-500',
    failed: 'bg-red-600 animate-pulse',
  };

  return (
    <div
      className={`terminal-pane h-full ${isFocused ? 'focused' : ''}`}
      onClick={() => { onFocus(); xtermRef.current?.focus(); }}
      style={{ borderColor: isFocused ? agent.color : undefined }}
    >
      {/* Header */}
      <div className="terminal-header" style={{ borderColor: agent.color }}>
        <div className={`status-dot ${statusColors[agent.status]}`} />
        {/* AC-4 dual-label — display name primary, archetype label small below
            when the user has renamed the agent on idealvibe (per GSD §5). */}
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-sm font-medium text-slate-200 truncate">{agent.displayName}</span>
          {(() => {
            const archetype = archetypeLabelFor(agent);
            return archetype ? (
              <span className="text-[10px] uppercase tracking-wide text-slate-500 truncate">{archetype}</span>
            ) : null;
          })()}
        </div>
        <span className="text-xs text-slate-500 capitalize">{agent.status}</span>
        <div className="flex-1" />

        {/* Scroll-lock toggle — PRIMARY auto-scroll control */}
        <button
          onClick={(e) => { e.stopPropagation(); toggleScrollLock(); }}
          className={`p-1 transition-colors ${scrollLocked ? 'text-purple-400' : 'text-slate-500 opacity-40'}`}
          title={scrollLocked ? 'Auto-scroll ON (click to unlock)' : 'Auto-scroll OFF (click to lock)'}
        >
          {scrollLocked ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
        </button>

        {/* Controls */}
        {agent.status === 'offline' ? (
          <button
            onClick={startAgent}
            className="p-1 text-slate-400 hover:text-green-400 transition-colors"
            title="Start Agent"
          >
            <Play className="w-4 h-4" />
          </button>
        ) : (
          <>
            <button
              onClick={stopAgent}
              className="p-1 text-slate-400 hover:text-red-400 transition-colors"
              title="Stop Agent"
            >
              <Square className="w-4 h-4" />
            </button>
            <button
              onClick={restartAgent}
              className="p-1 text-slate-400 hover:text-amber-400 transition-colors"
              title="Restart Agent"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </>
        )}
      </div>

      {/* Terminal */}
      <div className="relative flex-1 min-h-0">
        <div
          className="terminal-content h-full"
          ref={terminalRef}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={(e) => {
            e.stopPropagation();
            // Only focus terminal on explicit user click, don't steal from other inputs
            if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
              xtermRef.current?.focus();
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const term = xtermRef.current;
            if (term?.hasSelection()) {
              navigator.clipboard.writeText(term.getSelection());
              term.clearSelection();
            }
          }}
        />

        {/* "New output below" pill — visible when user is reading scrollback */}
        <button
          className="absolute bottom-3 right-3 flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-700/80 text-slate-200 hover:bg-slate-600/90 backdrop-blur-sm shadow-lg cursor-pointer select-none"
          style={{
            opacity: showScrollPill ? 1 : 0,
            pointerEvents: showScrollPill ? 'auto' : 'none',
            transition: 'opacity 150ms ease-in-out',
          }}
          onClick={(e) => {
            e.stopPropagation();
            xtermRef.current?.scrollToBottom();
            scrollPausedMap.set(agent.id, false);
            isScrollPaused.current = false;
            setShowScrollPill(false);
          }}
        >
          <ChevronDown className="w-3.5 h-3.5" />
          New output
        </button>
      </div>

    </div>
  );
}
