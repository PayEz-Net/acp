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
import { Play, Square, RotateCcw, ChevronDown } from 'lucide-react';

// Jon (2026-06): try the terminal WITHOUT forced auto-scroll-to-bottom. The explicit
// scrollToBottom() on every output/fit was yanking the view down while reading back up
// the convo (a fit/resize could reset the scroll-pause and re-pin to the bottom). With
// this OFF, xterm's natural scrolling applies: it follows the tail when you're at the
// bottom and STAYS PUT when you've scrolled up. The "jump to latest" pill still snaps you
// down manually. Flip to true to restore the old forced tail-follow.
const AUTO_FOLLOW_TAIL: boolean = false;

interface TerminalPaneProps {
  agent: AgentState;
  isFocused: boolean;
  onFocus: () => void;
  compact?: boolean;
}

export function TerminalPane({ agent, isFocused, onFocus, compact }: TerminalPaneProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { updateAgentStatus, setAgentTerminalId, registerTerminal, unregisterTerminal, backendAvailable } = useAppStore();
  const activeProjectId = useProjectStore((s) => s.activeProject)?.id;
  // Active team runtime for the per-pane badge (SPEC-team-runtime §3.4).
  // Runtime is team-uniform (one value per project), so the authoritative
  // per-pane value IS the active project's runtime_choice — after
  // reconcile-on-switch every pane in the team runs this. Reactive selector
  // so the badge re-renders when the project (and its runtime) changes.
  const teamRuntime = useProjectStore((s) => s.activeProject?.runtime_choice) ?? null;

  // Scroll-pause: user scrolls up = pause, scrolls back to bottom = resume. No timers.
  const isScrollPaused = useRef(false);
  const [showScrollPill, setShowScrollPill] = useState(false);

  // -- Resize handling ------------------------------------------------------
  // Simple debounced fit + PTY sync. No bottom-align shims — let xterm.js
  // handle its own layout naturally (Claude fix: remove all shims).
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleFit = useCallback((opts?: { immediate?: boolean }) => {
    if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
    const run = () => {
      const term = xtermRef.current;
      const fit = fitAddonRef.current;
      if (!term || !fit) return;

      const prevCols = term.cols;
      const prevRows = term.rows;
      try {
        fit.fit();
      } catch {
        // Container detached mid-transition — skip resize/scroll
        return;
      }

      // Bottom-row guard (#164): FitAddon proposes rows by flooring
      // container/cellHeight, but rounding + stale-dimension transitions can
      // leave the rendered grid taller than the visible container. Since the
      // pane is overflow:hidden, the surplus rows are clipped at the BOTTOM —
      // exactly where the agent's input prompt lives — so on large displays
      // the input "balloons" off the bottom of the viewport. Drop rows until
      // the rendered terminal fits inside its container; scrollback then
      // scrolls WITHIN the viewport (Jon: max-rows + scroll-within). Bounded
      // loop + DOM-measure only (no xterm private API); no-ops if it fits.
      const host = terminalRef.current;
      const screen = host?.querySelector('.xterm-screen') as HTMLElement | null;
      if (host && screen) {
        let guard = 0;
        while (screen.offsetHeight > host.clientHeight && term.rows > 1 && guard < 12) {
          term.resize(term.cols, term.rows - 1);
          guard++;
        }
      }

      const tid = useAppStore.getState().agents.find(a => a.name === agent.name)?.terminalId;
      if (tid && (term.cols !== prevCols || term.rows !== prevRows)) {
        window.electronAPI.resizeTerminal(tid, term.cols, term.rows);
      }
      if (AUTO_FOLLOW_TAIL && !isScrollPaused.current) {
        term.scrollToBottom();
      }
    };
    if (opts?.immediate) {
      run();
    } else {
      fitTimerRef.current = setTimeout(run, 100);
    }
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
    // Double RAF ensures container has settled in flex layout before measuring.
    // Use the shared scheduleFit (immediate, no debounce) so bottom-align
    // runs right away and the welcome message lands at the bottom of the pane.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scheduleFitRef.current({ immediate: true });
      });
    });

    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      // Ctrl+C copies when text is selected (else SIGINT falls through to PTY).
      if (e.ctrlKey && !e.shiftKey && e.key === 'c' && terminal.hasSelection()) {
        navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }

      // Paste: Ctrl+V / Cmd+V / Shift+Insert. The native DOM 'paste' event does
      // NOT fire reliably in the Claude TUI (helper-textarea focus race), and
      // the renderer can't read the clipboard either — navigator.clipboard
      // .readText() is permission-denied in the packaged build. So read the
      // clipboard from MAIN (ungated) and feed terminal.paste(), which emits a
      // single bracketed-paste sequence to the PTY. This is focus- and
      // event-dispatch-independent: the keydown fires whenever the terminal
      // has focus. preventDefault stops any native paste from double-firing.
      const isPaste =
        ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) ||
        (e.shiftKey && e.key === 'Insert');
      if (isPaste) {
        e.preventDefault();
        e.stopPropagation();
        window.electronAPI.readClipboardText()
          .then((text) => { if (text) xtermRef.current?.paste(text); })
          .catch(() => {});
        return false;
      }

      return true;
    });

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Scroll position IS the toggle — no timers, no fighting the user
    terminal.onScroll(() => {
      const atBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      if (!atBottom) {
        // User scrolled up — pause auto-scroll, respect their intent
        isScrollPaused.current = true;
      } else {
        // User returned to bottom — resume auto-scroll, hide pill
        isScrollPaused.current = false;
        setShowScrollPill(false);
      }
    });

    // Register terminal for mail push message injection
    registerTerminal(agent.name, terminal, activeProjectId);

    // Write welcome message based on agent
    const agentFlavor: Record<string, string[]> = {
      BAPert: [
        '\x1b[35m+--------------------------------------+\x1b[0m',
        '\x1b[35m�\x1b[0m  \x1b[1;35mBAPert\x1b[0m - Business Analyst          \x1b[35m�\x1b[0m',
        '\x1b[35m�\x1b[0m  Coordinator & Task Manager          \x1b[35m�\x1b[0m',
        '\x1b[35m+--------------------------------------+\x1b[0m',
        '',
        '\x1b[90m  "Keeping the team aligned and on track."\x1b[0m',
        '',
      ],
      NextPert: [
        '\x1b[32m+--------------------------------------+\x1b[0m',
        '\x1b[32m�\x1b[0m  \x1b[1;32mNextPert\x1b[0m - Frontend Developer      \x1b[32m�\x1b[0m',
        '\x1b[32m�\x1b[0m  React, Next.js, TypeScript          \x1b[32m�\x1b[0m',
        '\x1b[32m+--------------------------------------+\x1b[0m',
        '',
        '\x1b[90m  "Building beautiful UIs, one component at a time."\x1b[0m',
        '',
      ],
      DotNetPert: [
        '\x1b[36m+--------------------------------------+\x1b[0m',
        '\x1b[36m�\x1b[0m  \x1b[1;36mDotNetPert\x1b[0m - Backend Developer    \x1b[36m�\x1b[0m',
        '\x1b[36m�\x1b[0m  C#, .NET, APIs, Databases           \x1b[36m�\x1b[0m',
        '\x1b[36m+--------------------------------------+\x1b[0m',
        '',
        '\x1b[90m  "Solid backends. Reliable APIs. Always."\x1b[0m',
        '',
      ],
      Aurum: [
        '\x1b[38;5;208m+--------------------------------------+\x1b[0m',
        '\x1b[38;5;208m�\x1b[0m  \x1b[1;38;5;208mAurum\x1b[0m - Product Seer               \x1b[38;5;208m�\x1b[0m',
        '\x1b[38;5;208m�\x1b[0m  UX Strategy & Human Experience      \x1b[38;5;208m�\x1b[0m',
        '\x1b[38;5;208m+--------------------------------------+\x1b[0m',
        '',
        '\x1b[90m  "Less, but sharper."\x1b[0m',
        '',
      ],
      QAPert: [
        '\x1b[33m+--------------------------------------+\x1b[0m',
        '\x1b[33m�\x1b[0m  \x1b[1;33mQAPert\x1b[0m - Quality Assurance         \x1b[33m�\x1b[0m',
        '\x1b[33m�\x1b[0m  Code Review & Testing               \x1b[33m�\x1b[0m',
        '\x1b[33m+--------------------------------------+\x1b[0m',
        '',
        '\x1b[90m  "If it ships, it works. Period."\x1b[0m',
        '',
      ],
    };

    const flavor = agentFlavor[agent.name] || [
      `\x1b[1m${agent.name}\x1b[0m`,
      '',
    ];
    flavor.forEach(line => terminal.writeln(line));
    terminal.writeln('\x1b[90m  Press ? to start agent...\x1b[0m');
    terminal.writeln('');

    // Handle resize — route through the single guarded scheduleFit so the
    // bottom-row clamp (#164) applies on container resize, the primary
    // trigger. scheduleFit owns the debounce + PTY sync + scroll-to-bottom;
    // no separate inline fit()/timer (that path skipped the clamp).
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
  // NOT resize the container (so the ResizeObserver won't fire) � trigger the
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

  // Receive PTY output
  useEffect(() => {
    if (!agent.terminalId) return;

    const unsubscribe = window.electronAPI.onTerminalData((data) => {
      if (data.terminalId === agent.terminalId && xtermRef.current) {
        const term = xtermRef.current;
        term.write(data.data);
        if (AUTO_FOLLOW_TAIL && !isScrollPaused.current) {
          term.scrollToBottom();
        } else if (isScrollPaused.current) {
          // User is reading scrollback — show "new output" pill, don't interrupt
          setShowScrollPill(true);
        }
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
      // settings.agentProvider. Null/undefined ? main process picks global.
      const activeProject = useProjectStore.getState().activeProject;
      const projectRuntime = activeProject?.runtime_choice ?? null;

      // Workspace root = the PROJECT's repo_path, period. The renderer does NOT
      // compose or resolve a workDir — it FORWARDS the project's repo_path to the
      // single authority (pty.ts resolveWorkDir, main-side), which validates it.
      // The per-agent workDir is deliberately IGNORED (no per-agent editor; it was
      // pure landmine — empty -> main's resolveWorkDir('') -> null -> WorkDirError
      // -> acp-api 500, the "Aurum still no good" bug). One authority: the project.
      // '' is the empty sentinel that drives that intended hard-stop, NOT a
      // fallback path (workspace-debt guard B2: no renderer-composed path).
      const projectRepo = activeProject?.repo_path || '';

      // a-renderer leg [1]: per-agent Claude effort from the active project's
      // team row. NULL/absent ? undefined: OMIT it so pty.ts's resolver applies
      // the single global default; NEVER substitute 'high' here (Aurum 1413).
      // Sent on BOTH manual paths � the lifecycle POST [primary, path-3] AND the
      // IPC fallback [path-1] � per QA 1417/1418.
      const teamMember = (useProjectStore.getState().currentProjectTeam ?? []).find(
        (m) => m.agent_name === agent.name,
      );
      const effortOverride = teamMember?.effort_override ?? undefined;

      if (backendAvailable) {
        // Phase 2: lifecycle via acp-api ? callback server ? node-pty
        const secret = await window.electronAPI.getLocalSecret();
        const res = await fetch(`http://127.0.0.1:3001/v1/lifecycle/agents/${encodeURIComponent(agent.name)}/spawn`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
            ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify({
            workDir: projectRepo,
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
        // Extract terminalId � API returns snake_case terminal_id
        const extractId = (d: any) => d?.terminal_id || d?.terminalId;
        // 409 = already running � reattach via acp-api (returns 200 with reattached:true)
        if (!res.ok) {
          throw new Error(data.message || data.error?.message || `Spawn failed: ${res.status}`);
        }
        terminalId = extractId(data.data) || extractId(data);
      } else {
        // FLAG 6 (SPEC-team-runtime §3.3, BAPert #84135): the phantom direct-IPC
        // spawn fallback is DELETED. The backend (acp-api) is what resolves the
        // team runtime (resolveTeamRuntime); without it we cannot know which
        // runtime to launch, and guessing the machine global is exactly the
        // masking fallback this spec kills. So hard-surface and spawn NOTHING —
        // same throw-before-spawn philosophy as the unset-runtime block, never a
        // guessed/degraded boot (mem: fallback-to-avoid-crash IS the hole).
        throw new Error('Backend unavailable — cannot resolve the team runtime, so this agent cannot start. Reconnect the ACP backend and retry.');
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

  // Stop agent � kill PTY via both lifecycle API and direct IPC
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

  // Restart agent � stop then start fresh
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
        {/* AC-4 dual-label � display name primary, archetype label small below
            when the user has renamed the agent on idealvibe (per GSD �5). */}
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
        {/* Active-runtime badge (SPEC-team-runtime §3.4) — the team's runtime
            (claude/kimi/codex) must be visible at a glance so a silent
            project-level override is never invisible. */}
        {teamRuntime ? (
          <span
            className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
              teamRuntime === 'claude'
                ? 'bg-amber-500/15 text-amber-300'
                : teamRuntime === 'kimi'
                ? 'bg-violet-500/15 text-violet-300'
                : 'bg-cyan-500/15 text-cyan-300'
            }`}
            title={`Team runtime: ${teamRuntime}`}
          >
            {teamRuntime}
          </span>
        ) : null}
        <div className="flex-1" />

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
            // Classic terminal right-click: copy the selection if there is one,
            // otherwise paste. Paste reads the clipboard from main (same reason
            // as the Ctrl+V path — renderer clipboard read is permission-denied).
            if (term?.hasSelection()) {
              navigator.clipboard.writeText(term.getSelection());
              term.clearSelection();
            } else if (term) {
              window.electronAPI.readClipboardText()
                .then((text) => { if (text) xtermRef.current?.paste(text); })
                .catch(() => {});
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
          }}
        >
          <ChevronDown className="w-3.5 h-3.5" />
          New output
        </button>
      </div>

    </div>
  );
}
