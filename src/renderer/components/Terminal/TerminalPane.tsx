import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { AgentState } from '@shared/types';
import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentOutputStore } from '../../stores/agentOutputStore';
import { useAcpSessionStore } from '../../stores/acpSessionStore';
import { terminalStreamNormalizer } from '../../lib/terminalStream';
import { UnifiedTerminal } from './UnifiedTerminal';
import { getStatusPill } from './TerminalFooter';
import { Play, Square, RotateCcw } from 'lucide-react';

// Global dedupe so two pane instances / StrictMode remounts cannot both spawn
// the same agent. Keyed by agent name; coalesces concurrent attempts.
const spawnPromiseMap = new Map<string, Promise<string>>();

interface TerminalPaneProps {
  agent: AgentState;
  isFocused: boolean;
  onFocus: () => void;
  compact?: boolean;
}

export function TerminalPane({ agent, isFocused, onFocus, compact }: TerminalPaneProps) {
  const agents = useAppStore((s) => s.agents);
  const updateAgentStatus = useAppStore((s) => s.updateAgentStatus);
  const setAgentTerminalId = useAppStore((s) => s.setAgentTerminalId);
  const backendAvailable = useAppStore((s) => s.backendAvailable);
  const teamRuntime = useProjectStore((s) => s.activeProject?.runtime_choice) ?? null;
  const [isThinkingLive, setIsThinkingLive] = useState(false);
  // Guard against duplicate spawn calls from React StrictMode double-invoke or
  // rapid prop changes before the first async spawn resolves.
  const spawnPendingRef = useRef(false);

  // Provider badge is only useful when the team mixes providers. Use the same
  // runtime_choice authority here so stale agent.provider values don't create a
  // false "mixed" badge when every agent is actually running on the team runtime.
  const mixedProviders = useMemo(() => {
    const providers = new Set(agents.map((a) => (teamRuntime ?? a.provider)).filter(Boolean));
    return providers.size > 1;
  }, [agents, teamRuntime]);

  // runtime_choice is the single authority; agent.provider may be stale.
  const effectiveProvider = teamRuntime ?? agent.provider ?? null;

  // Push a visible error line into the agent output stream when something fails.
  const emitErrorLine = useCallback((message: string) => {
    useAgentOutputStore.getState().addLine({
      agent: agent.name,
      terminal_id: agent.terminalId,
      line: `Failed to start: ${message}`,
      ts: new Date().toISOString(),
    });
  }, [agent.name, agent.terminalId]);

  const startAgent = useCallback(async () => {
    if (spawnPendingRef.current) {
      console.debug(`[Agent] Spawn already in flight for ${agent.name}; skipping duplicate`);
      return;
    }
    // Global dedupe: if another pane / StrictMode instance is already spawning
    // this agent, await that promise instead of starting a second spawn.
    const inFlight = spawnPromiseMap.get(agent.name);
    if (inFlight) {
      console.debug(`[Agent] Coalescing with in-flight spawn for ${agent.name}`);
      try {
        const terminalId = await inFlight;
        if (terminalId && !agent.terminalId) {
          setAgentTerminalId(agent.id, terminalId);
          updateAgentStatus(agent.id, 'ready');
        }
      } catch (err) {
        console.error(`[Agent] Coalesced spawn failed for ${agent.name}:`, err);
      }
      return;
    }

    spawnPendingRef.current = true;
    updateAgentStatus(agent.id, 'starting');

    const spawnPromise = (async (): Promise<string> => {
      let terminalId: string;

      const activeProject = useProjectStore.getState().activeProject;
      const projectRuntime = activeProject?.runtime_choice ?? null;
      const projectRepo = activeProject?.repo_path || '';
      let team = useProjectStore.getState().currentProjectTeam ?? [];
      if (activeProject && team.length === 0) {
        // Boot-race backstop: the override-carrying roster (GET
        // /v1/projects/:id/team) may not have landed yet — fetch it now
        // rather than spawn plain (no -m / effort would reach the CLI).
        await useProjectStore.getState().fetchCurrentProjectTeam(activeProject.id);
        team = useProjectStore.getState().currentProjectTeam ?? [];
      }
      const teamMember = team.find(
        (m) => m.agent_name === agent.name,
      );
      const effortOverride = teamMember?.effort_override ?? undefined;
      const modelOverride = teamMember?.model_override ?? undefined;

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
            ...(modelOverride ? { model: modelOverride } : {}),
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

      return terminalId;
    })();

    spawnPromiseMap.set(agent.name, spawnPromise);

    try {
      const terminalId = await spawnPromise;
      setAgentTerminalId(agent.id, terminalId);
      updateAgentStatus(agent.id, 'ready');
    } catch (err) {
      console.error('Failed to start agent:', err);
      emitErrorLine(err instanceof Error ? err.message : String(err));
      updateAgentStatus(agent.id, 'error');
    } finally {
      spawnPendingRef.current = false;
      spawnPromiseMap.delete(agent.name);
    }
  }, [agent.id, agent.name, agent.terminalId, backendAvailable, updateAgentStatus, setAgentTerminalId, emitErrorLine]);

  const stopAgent = useCallback(async () => {
    const tid = agent.terminalId;
    try {
      if (backendAvailable) {
        const secret = await window.electronAPI.getLocalSecret();
        const activeProject = useProjectStore.getState().activeProject;
        const res = await fetch(`http://127.0.0.1:3001/v1/lifecycle/agents/${encodeURIComponent(agent.name)}/kill`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
            ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify({
            agentName: agent.name,
            ...(tid ? { terminalId: tid } : {}),
            ...(activeProject?.id != null ? { projectId: activeProject.id } : {}),
          }),
        });
        console.log(`[Agent] Kill response for ${agent.name}:`, res.status, await res.json().catch(() => ({})));
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
    useAcpSessionStore.getState().clearSession(agent.name);
    setAgentTerminalId(agent.id, undefined as any);
    spawnPendingRef.current = false;
    updateAgentStatus(agent.id, 'offline');
  }, [agent.id, agent.name, agent.terminalId, backendAvailable, updateAgentStatus, setAgentTerminalId]);

  const restartAgent = useCallback(async () => {
    await stopAgent();
    await new Promise(r => setTimeout(r, 500));
    await startAgent();
  }, [stopAgent, startAgent]);

  useEffect(() => {
    if (agent.autoStart && agent.status === 'offline' && !agent.terminalId) {
      startAgent();
    }
  }, [agent.autoStart, agent.status, agent.terminalId, startAgent]);

  const statusPill = isThinkingLive
    ? { label: 'Thinking…', color: 'bg-acp-status-busy', animate: true }
    : getStatusPill(agent.status);

  const providerBadgeColor =
    effectiveProvider === 'claude'
      ? 'bg-amber-500/15 text-amber-300'
      : effectiveProvider === 'kimi'
      ? 'bg-violet-500/15 text-violet-300'
      : 'bg-cyan-500/15 text-cyan-300';

  return (
    // State is carried by the WHOLE PANE, not a 2px dot. Across a five-pane
    // grid you answer "who is working / who wants me / where am I typing" with
    // peripheral vision, which reads area and colour — not glyphs. Three signals,
    // deliberately non-competing so they can stack without becoming mush:
    //   thinking → amber ring + outer glow (motion-free; an animated border
    //              across 5 panes is a strobe, and this tool gets stared at)
    //   focused  → indigo ring, brightest, because it answers "where does my
    //              typing go" and a wrong answer there is destructive
    //   idle     → recedes entirely
    // Focus wins when both apply: a thinking pane you are typing into needs to
    // read as YOURS first.
    <div
      className={`
        h-full flex flex-col overflow-hidden rounded-xl border transition-shadow duration-200
        ${
          isFocused
            ? 'border-indigo-400/70 shadow-[inset_0_0_0_1px_rgba(129,140,248,0.55),0_0_0_1px_rgba(129,140,248,0.25)]'
            : isThinkingLive
              ? 'border-amber-400/60 shadow-[0_0_14px_-2px_rgba(251,191,36,0.35)]'
              : 'border-acp-border'
        }
        bg-acp-surface
      `}
      onClick={onFocus}
      data-testid="terminal-pane"
    >
      {/* Header — stays at the top */}
      <div className="relative h-10 shrink-0 flex items-center gap-2 px-3 border-b border-acp-border bg-acp-surface-raised">
        {/* 2px was decorative. 10px reads at a glance and carries a soft halo
            when live, so "busy" is legible from across the desk. */}
        <span
          className={`w-2.5 h-2.5 shrink-0 rounded-full ${statusPill.color} ${
            statusPill.animate ? 'animate-pulse shadow-[0_0_8px_1px_rgba(251,191,36,0.6)]' : ''
          }`}
          title={statusPill.label}
        />

        {/* The agent's NAME is the primary label — you scan for "who", then
            state. Was text-sm; bumped and tightened so it holds its own against
            the brighter transcript below without shouting. */}
        <span className="text-[15px] font-semibold tracking-tight text-acp-text-primary truncate">
          {agent.displayName}
        </span>

        <span
          className={`
            text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 tabular-nums
            ${statusPill.color}/20 ${statusPill.color.replace('bg-', 'text-')}
          `}
        >
          {statusPill.label}
        </span>

        {mixedProviders && effectiveProvider && (
          <span
            className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${providerBadgeColor}`}
            title={`Provider: ${effectiveProvider}`}
          >
            {effectiveProvider}
          </span>
        )}

        <div className="flex-1" />

        {/* Controls */}
        {agent.status === 'offline' ? (
          <button
            onClick={(e) => { e.stopPropagation(); startAgent(); }}
            className="p-1 text-acp-text-muted hover:text-acp-status-ready transition-colors"
            title="Start Agent"
          >
            <Play className="w-4 h-4" />
          </button>
        ) : (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); stopAgent(); }}
              className="p-1 text-acp-text-muted hover:text-acp-status-error transition-colors"
              title="Stop Agent"
            >
              <Square className="w-4 h-4" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); restartAgent(); }}
              className="p-1 text-acp-text-muted hover:text-acp-status-busy transition-colors"
              title="Restart Agent"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </>
        )}
      </div>

      {/* Terminal surface + footer + composer */}
      <UnifiedTerminal
        agent={agent}
        terminalId={agent.terminalId}
        isFocused={isFocused}
        onFocus={onFocus}
        compact={compact}
        onThinkingLiveChange={setIsThinkingLive}
      />
    </div>
  );
}
