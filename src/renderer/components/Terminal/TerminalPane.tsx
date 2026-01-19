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
  const { updateAgentStatus, setAgentTerminalId } = useAppStore();

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

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      xtermRef.current = null;
    };
  }, [compact]);

  // Handle terminal input
  useEffect(() => {
    if (!xtermRef.current || !agent.terminalId) return;

    const terminal = xtermRef.current;

    // Send keystrokes to PTY
    const dataHandler = terminal.onData((data) => {
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
        xtermRef.current.write(data.data);

        // Detect status from output
        if (data.data.includes('Thinking') || data.data.includes('Working')) {
          updateAgentStatus(agent.id, 'busy');
        } else if (data.data.includes('$ ') || data.data.includes('> ')) {
          updateAgentStatus(agent.id, 'idle');
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

  // Start agent
  const startAgent = useCallback(async () => {
    updateAgentStatus(agent.id, 'starting');
    try {
      const terminalId = await window.electronAPI.spawnAgent(agent.name, agent.workDir);
      setAgentTerminalId(agent.id, terminalId);
      updateAgentStatus(agent.id, 'ready');
    } catch (err) {
      console.error('Failed to start agent:', err);
      updateAgentStatus(agent.id, 'error');
    }
  }, [agent.id, agent.name, agent.workDir, updateAgentStatus, setAgentTerminalId]);

  // Stop agent
  const stopAgent = useCallback(() => {
    if (agent.terminalId) {
      window.electronAPI.killTerminal(agent.terminalId);
      updateAgentStatus(agent.id, 'offline');
    }
  }, [agent.id, agent.terminalId, updateAgentStatus]);

  // Auto-start if configured
  useEffect(() => {
    if (agent.autoStart && agent.status === 'offline' && !agent.terminalId) {
      startAgent();
    }
  }, [agent.autoStart, agent.status, agent.terminalId, startAgent]);

  const statusColors: Record<AgentState['status'], string> = {
    offline: 'bg-slate-500',
    starting: 'bg-purple-500 animate-pulse',
    ready: 'bg-blue-500',
    busy: 'bg-amber-500 animate-pulse',
    idle: 'bg-green-500',
    error: 'bg-red-500',
  };

  return (
    <div
      className={`terminal-pane h-full ${isFocused ? 'focused' : ''}`}
      onClick={onFocus}
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
              onClick={() => { stopAgent(); setTimeout(startAgent, 500); }}
              className="p-1 text-slate-400 hover:text-amber-400 transition-colors"
              title="Restart Agent"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </>
        )}
      </div>

      {/* Terminal */}
      <div className="terminal-content" ref={terminalRef} />
    </div>
  );
}
