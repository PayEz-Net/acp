import { useEffect, useCallback } from 'react';
import { AgentState } from '@shared/types';
import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentOutputStore } from '../../stores/agentOutputStore';
import { terminalStreamNormalizer } from '../../lib/terminalStream';
import { archetypeLabelFor } from '../../lib/agentLabels';
import { UnifiedTerminal } from './UnifiedTerminal';
import { Play, Square, RotateCcw } from 'lucide-react';

interface TerminalPaneProps {
  agent: AgentState;
  isFocused: boolean;
  onFocus: () => void;
  compact?: boolean;
}

export function TerminalPane({ agent, isFocused, onFocus, compact }: TerminalPaneProps) {
  const { updateAgentStatus, setAgentTerminalId, backendAvailable } = useAppStore();
  // Active team runtime for the per-pane badge (SPEC-team-runtime §3.4).
  const teamRuntime = useProjectStore((s) => s.activeProject?.runtime_choice) ?? null;

  // Push a visible error line into the agent output stream when something fails.
  const emitErrorLine = useCallback((message: string) => {
    useAgentOutputStore.getState().addLine({
      agent: agent.name,
      terminal_id: agent.terminalId,
      line: `Failed to start: ${message}`,
      ts: new Date().toISOString(),
    });
  }, [agent.name, agent.terminalId]);

  // Start agent — route through acp-api when available, fallback to direct IPC
  const startAgent = useCallback(async () => {
    updateAgentStatus(agent.id, 'starting');
    try {
      let terminalId: string;

      const activeProject = useProjectStore.getState().activeProject;
      const projectRuntime = activeProject?.runtime_choice ?? null;
      const projectRepo = activeProject?.repo_path || '';
      const teamMember = (useProjectStore.getState().currentProjectTeam ?? []).find(
        (m) => m.agent_name === agent.name,
      );
      const effortOverride = teamMember?.effort_override ?? undefined;

      if (backendAvailable) {
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
            ...(activeProject?.id != null ? { projectId: activeProject.id } : {}),
          }),
        });
        const data = await res.json();
        console.log(`[Agent] Spawn response for ${agent.name}:`, res.status, data, projectRuntime ? `runtime: ${projectRuntime}` : '(global runtime)');
        const extractId = (d: any) => d?.terminal_id || d?.terminalId;
        if (!res.ok) {
          throw new Error(data.message || data.error?.message || `Spawn failed: ${res.status}`);
        }
        terminalId = extractId(data.data) || extractId(data);
      } else {
        throw new Error('Backend unavailable — cannot resolve the team runtime, so this agent cannot start. Reconnect the ACP backend and retry.');
      }

      setAgentTerminalId(agent.id, terminalId);
      updateAgentStatus(agent.id, 'ready');
    } catch (err) {
      console.error('Failed to start agent:', err);
      emitErrorLine(err instanceof Error ? err.message : String(err));
      updateAgentStatus(agent.id, 'error');
    }
  }, [agent.id, agent.name, backendAvailable, updateAgentStatus, setAgentTerminalId, emitErrorLine]);

  // Stop agent — kill PTY via both lifecycle API and direct IPC, then drop the
  // terminal stream normalizer history and clear the output store so stale
  // frames do not bleed into the next session.
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
      if (tid) window.electronAPI.killTerminal(tid);
    } catch (err) {
      console.error('Failed to stop agent:', err);
      if (tid) window.electronAPI.killTerminal(tid);
    }
    if (tid) {
      terminalStreamNormalizer.dropTerminal(tid);
      useAgentOutputStore.getState().clear(agent.name);
    }
    setAgentTerminalId(agent.id, undefined as any);
    updateAgentStatus(agent.id, 'offline');
  }, [agent.id, agent.name, agent.terminalId, backendAvailable, updateAgentStatus, setAgentTerminalId]);

  // Restart agent — stop then start fresh
  const restartAgent = useCallback(async () => {
    await stopAgent();
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
      onClick={onFocus}
      style={{ borderColor: isFocused ? agent.color : undefined }}
    >
      {/* Header */}
      <div className="terminal-header" style={{ borderColor: agent.color }}>
        <div className={`status-dot ${statusColors[agent.status]}`} />
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

      {/* Terminal surface */}
      <UnifiedTerminal
        agentName={agent.name}
        terminalId={agent.terminalId}
        isFocused={isFocused}
        onFocus={onFocus}
        compact={compact}
      />
    </div>
  );
}
