import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { AgentState } from '@shared/types';
import { useAppStore } from '../../stores/appStore';
import { Play, Square, RotateCcw } from 'lucide-react';

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

  // Initialize terminal
  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: compact ? 11 : 13,
      fontFamily: 'Consolas, "Courier New", monospace',
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
    fitAddon.fit();

    // Enable Ctrl+C to copy when text is selected (otherwise send to PTY)
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && e.key === 'c' && terminal.hasSelection()) {
        navigator.clipboard.writeText(terminal.getSelection());
        return false; // Don't send to PTY
      }
      // Ctrl+V to paste
      if (e.ctrlKey && e.key === 'v') {
        navigator.clipboard.readText().then((text) => {
          if (text) terminal.paste(text);
        });
        return false;
      }
      return true;
    });

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Register terminal for mail push message injection
    registerTerminal(agent.name, terminal);

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
    flavor.forEach(line => terminal.writeln(line));
    terminal.writeln('\x1b[90m  Press ▷ to start agent...\x1b[0m');
    terminal.writeln('');

    // Handle resize — debounce fit + scrollToBottom to prevent scroll jump
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
        terminal.scrollToBottom();
      }, 100);
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
      unregisterTerminal(agent.name);
      terminal.dispose();
      xtermRef.current = null;
    };
  }, [compact, agent.name, registerTerminal, unregisterTerminal]);

  // Handle terminal input
  useEffect(() => {
    if (!xtermRef.current || !agent.terminalId) return;

    const terminal = xtermRef.current;
    terminal.focus();

    // Send keystrokes to PTY
    const dataHandler = terminal.onData((data) => {
      console.log(`[Terminal] ${agent.name} input:`, JSON.stringify(data));
      window.electronAPI.writeTerminal(agent.terminalId!, data);
    });

    return () => {
      dataHandler.dispose();
    };
  }, [agent.terminalId]);

  // Receive PTY output
  useEffect(() => {
    if (!agent.terminalId) return;

    const unsubscribe = window.electronAPI.onTerminalData((data) => {
      if (data.terminalId === agent.terminalId && xtermRef.current) {
        const term = xtermRef.current;
        // Check if user is at bottom before write (don't steal scroll from scrollback reading)
        const wasAtBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
        term.write(data.data);
        // Snap to bottom if user was already there
        if (wasAtBottom) {
          term.scrollToBottom();
        }

        // Detect agent status from Claude Code output patterns
        const chunk = data.data;

        // Claude Code prompt "❯" means idle/waiting for input
        if (chunk.includes('\u276F')) {
          updateAgentStatus(agent.id, 'idle');
        }
        // Active work indicators
        else if (
          chunk.includes('Thinking') ||
          chunk.includes('Read(') || chunk.includes('Edit(') || chunk.includes('Write(') ||
          chunk.includes('Bash(') || chunk.includes('Glob(') || chunk.includes('Grep(') ||
          chunk.includes('Agent(') ||
          chunk.includes('\u25CF') // ● bullet used for tool output lines
        ) {
          updateAgentStatus(agent.id, 'busy');
        }
      }
    });

    return () => unsubscribe();
  }, [agent.terminalId, agent.id, updateAgentStatus]);

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

      if (backendAvailable) {
        // Phase 2: lifecycle via acp-api → callback server → node-pty
        const secret = await window.electronAPI.getLocalSecret();
        const res = await fetch(`http://127.0.0.1:3001/v1/lifecycle/agents/${encodeURIComponent(agent.name)}/spawn`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify({ workDir: agent.workDir }),
        });
        const data = await res.json();
        console.log(`[Agent] Spawn response for ${agent.name}:`, res.status, data);
        // Extract terminalId — API returns snake_case terminal_id
        const extractId = (d: any) => d?.terminal_id || d?.terminalId;
        // 409 = already running — reattach via acp-api (returns 200 with reattached:true)
        if (!res.ok) {
          throw new Error(data.message || data.error?.message || `Spawn failed: ${res.status}`);
        }
        terminalId = extractId(data.data) || extractId(data);
      } else {
        // Fallback: direct IPC to Electron main
        terminalId = await window.electronAPI.spawnAgent(agent.name, agent.workDir);
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

  // Legacy restart via acp-api (unused — keeping restartAgent simple above)
  const _restartViaLifecycle = useCallback(async () => {
    if (backendAvailable) {
      updateAgentStatus(agent.id, 'starting');
      try {
        const secret = await window.electronAPI.getLocalSecret();
        const res = await fetch(`http://127.0.0.1:3001/v1/lifecycle/agents/${encodeURIComponent(agent.name)}/restart`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
          },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error?.message || `Restart failed: ${res.status}`);
        const extractId = (d: any) => d?.terminal_id || d?.terminalId;
        const terminalId = extractId(data.data) || extractId(data);
        if (terminalId) setAgentTerminalId(agent.id, terminalId);
        updateAgentStatus(agent.id, 'ready');
      } catch (err) {
        console.error('Failed to restart agent:', err);
        updateAgentStatus(agent.id, 'error');
      }
    } else {
      await stopAgent();
      setTimeout(startAgent, 500);
    }
  }, [agent.id, agent.name, backendAvailable, updateAgentStatus, setAgentTerminalId, stopAgent, startAgent]);

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
        <span className="text-sm font-medium text-slate-200">{agent.displayName}</span>
        <span className="text-xs text-slate-500 capitalize">{agent.status}</span>
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
      <div
        className="terminal-content"
        ref={terminalRef}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={(e) => {
          e.stopPropagation();
          xtermRef.current?.focus();
          const textarea = terminalRef.current?.querySelector('textarea');
          if (textarea) textarea.focus();
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

    </div>
  );
}
