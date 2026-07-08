import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { X, Trash2, Pause, Play, ChevronDown, Terminal } from 'lucide-react';
import { useAgentOutputStore, type AgentOutputLine } from '../../stores/agentOutputStore';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAcpSessionStore } from '../../stores/acpSessionStore';
import { ThinkingBlock } from '../ThinkingBlock';
import { CodeChangeCard } from '../Terminal/CodeChangeCard';
import { providerBadgeClasses, providerLabel, type CodeProvider } from '../../lib/agentProviders';

interface AgentOutputPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const AUTO_SCROLL_THRESHOLD_PX = 40;

export function AgentOutputPanel({ isOpen, onClose }: AgentOutputPanelProps) {
  const paused = useAgentOutputStore((s) => s.paused);
  const selectedAgent = useAgentOutputStore((s) => s.selectedAgent);
  const setPaused = useAgentOutputStore((s) => s.setPaused);
  const setSelectedAgent = useAgentOutputStore((s) => s.setSelectedAgent);
  const clear = useAgentOutputStore((s) => s.clear);
  const lines = useAgentOutputStore((s) => s.lines);
  const agents = useAppStore((s) => s.agents);
  const showThinking = useAppStore((s) => s.settings.showThinking) !== false;
  const teamRuntime = useProjectStore((s) => s.activeProject?.runtime_choice) ?? null;
  const acpSessions = useAcpSessionStore((s) => s.sessions);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showNewOutput, setShowNewOutput] = useState(false);
  const userScrolledRef = useRef(false);
  const rafScrollRef = useRef<number | null>(null);

  const { filtered, allHiddenByKimi } = useMemo(() => {
    const base = selectedAgent ? lines.filter((l) => l.agent === selectedAgent) : lines;
    // Kimi runs through the ACP transcript in the terminal pane; showing the raw
    // PTY stream here is just trash characters and redraw noise. Hide lines for
    // any agent that is currently in an active ACP session as well.
    const visible = base.filter((l) => {
      const agent = agents.find((a) => a.name === l.agent);
      const provider = (teamRuntime ?? l.provider ?? agent?.provider) as CodeProvider | undefined;
      if (provider === 'kimi') return false;
      const acpSession = acpSessions.get(l.agent);
      if (acpSession?.sessionId || acpSession?.runtimeMode === 'acp') return false;
      return true;
    });
    const allHiddenByKimi = base.length > 0 && visible.length === 0;
    return { filtered: visible, allHiddenByKimi };
  }, [lines, selectedAgent, agents, teamRuntime, acpSessions]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 5,
    getItemKey: (index) => filtered[index]?.id ?? `fallback-${index}`,
  });

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  // Auto-scroll to bottom when new lines arrive, unless paused or user scrolled up.
  useEffect(() => {
    if (!isOpen) return;
    if (paused) {
      setShowNewOutput(true);
      return;
    }
    if (rafScrollRef.current) cancelAnimationFrame(rafScrollRef.current);
    rafScrollRef.current = requestAnimationFrame(() => {
      rafScrollRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      const nearBottom = userScrolledRef.current
        ? el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD_PX
        : true;
      if (nearBottom) {
        virtualizer.scrollToIndex(filtered.length - 1, { align: 'end', behavior: 'auto' });
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
  }, [filtered.length, isOpen, paused, virtualizer]);

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
  }, [paused, setPaused]);

  const agentNames = useMemo(() => Array.from(new Set(lines.map((l) => l.agent))), [lines]);

  const resumeFollow = useCallback(() => {
    setPaused(false);
    setShowNewOutput(false);
    userScrolledRef.current = false;
    virtualizer.scrollToIndex(filtered.length - 1, { align: 'end', behavior: 'auto' });
  }, [filtered.length, setPaused, virtualizer]);

  if (!isOpen) return null;

  return (
    <div className="w-[28rem] min-w-[24rem] max-w-full bg-slate-900 border-l border-slate-700 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-semibold text-slate-200">Agent Output</span>
          <span className="text-xs text-slate-500">{filtered.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPaused(!paused)}
            className={`p-1.5 rounded transition-colors ${paused ? 'text-amber-400 hover:text-amber-300 hover:bg-slate-800' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
            title={paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => clear(selectedAgent ?? undefined)}
            className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded transition-colors"
            title={selectedAgent ? `Clear ${selectedAgent}` : 'Clear all'}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Agent filter */}
      <div className="px-3 py-2 border-b border-slate-800 shrink-0 flex items-center gap-2 overflow-x-auto">
        <button
          onClick={() => setSelectedAgent(null)}
          className={`text-xs px-2 py-1 rounded-full transition-colors whitespace-nowrap ${
            selectedAgent === null
              ? 'bg-emerald-600 text-white'
              : 'bg-slate-800 text-slate-400 hover:text-slate-200'
          }`}
        >
          All
        </button>
        {agentNames.map((name) => {
          const agent = agents.find((a) => a.name === name);
          // runtime_choice is the single authority; agent.provider may be stale.
          const provider = (teamRuntime ?? agent?.provider) as CodeProvider | undefined;
          const active = selectedAgent === name;
          return (
            <button
              key={name}
              onClick={() => setSelectedAgent(name)}
              className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full transition-colors whitespace-nowrap border ${
                active
                  ? provider
                    ? providerBadgeClasses(provider)
                    : 'bg-slate-600 text-white border-slate-500'
                  : 'bg-slate-800 text-slate-400 border-transparent hover:text-slate-200'
              }`}
            >
              <span>{name}</span>
              {provider && (
                <span className="opacity-80">{providerLabel(provider)}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Output stream */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3 text-sm font-mono relative"
      >
        {filtered.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-2">
            <Terminal className="w-8 h-8 opacity-30" />
            <p className="text-xs text-center px-4">
              {allHiddenByKimi
                ? 'Kimi output is shown in the terminal pane.'
                : 'Agent terminal output will appear here.'}
            </p>
          </div>
        )}

        {filtered.length > 0 && (
          <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
            {virtualItems.map((virtualItem) => {
              const line = filtered[virtualItem.index];
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
                  <AgentOutputLineItem line={line} showThinking={showThinking} teamRuntime={teamRuntime} agents={agents} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* New-output pill */}
      {showNewOutput && paused && (
        <button
          onClick={resumeFollow}
          className="absolute bottom-4 right-4 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 shadow-lg cursor-pointer"
        >
          <ChevronDown className="w-3.5 h-3.5" />
          New output
        </button>
      )}
    </div>
  );
}

interface AgentOutputLineItemProps {
  line: AgentOutputLine;
  showThinking: boolean;
  teamRuntime: string | null;
  agents: import('@shared/types').AgentState[];
}

function AgentOutputLineItem({ line, showThinking, teamRuntime, agents }: AgentOutputLineItemProps) {
  const agent = agents.find((a) => a.name === line.agent);
  // runtime_choice is the single authority; line.provider/agent.provider may be stale.
  const provider = (teamRuntime ?? line.provider ?? agent?.provider) as CodeProvider | undefined;
  const isUser = line.source === 'user';
  const isInfo = line.source === 'info';
  return (
    <div
      className={`flex flex-col py-0.5 rounded px-1 -mx-1 ${
        isUser ? 'items-end' : 'items-start'
      } ${isInfo ? 'opacity-70' : ''} hover:bg-slate-800/50`}
    >
      <div className={`flex items-start gap-2 w-full ${isUser ? 'justify-end' : ''}`}>
        {!isUser && (
          <span
            className={`text-[10px] font-semibold uppercase tracking-wide shrink-0 rounded px-1 py-0.5 h-fit ${
              provider ? providerBadgeClasses(provider) : 'bg-slate-700 text-slate-300'
            }`}
          >
            {line.agent}
          </span>
        )}
        {line.thinkingLive ? (
          // Live thinking is shown as a compact inline indicator next to
          // the agent badge, matching the terminal-pane footer pill. The
          // placeholder line text is not rendered as prose, so it cannot
          // wrap or splatter mid-word into the scrollback.
          <div className="flex-1 min-w-0">
            <ThinkingBlock label={line.line || 'Thinking...'} content={line.thinking || ''} live compact />
          </div>
        ) : line.codeChange ? (
          <div className="flex-1 min-w-0">
            <CodeChangeCard codeChange={line.codeChange} compact />
          </div>
        ) : (
          <span
            className={`min-w-0 whitespace-pre-wrap leading-tight rounded ${
              isUser
                ? 'px-2 py-1 break-words bg-blue-600/25 text-blue-100'
                : isInfo
                  ? 'flex-1 px-1.5 py-0.5 overflow-x-auto text-slate-400 italic text-xs'
                  : 'flex-1 px-1.5 py-0.5 overflow-x-auto text-slate-300'
            }`}
          >
            {line.line}
          </span>
        )}
      </div>
      {showThinking && !line.thinkingLive && line.thinking !== undefined && (
        <div className={`mt-1 ${isUser ? 'mr-0' : 'w-full'}`}>
          <ThinkingBlock label="Thinking" content={line.thinking} compact />
        </div>
      )}
    </div>
  );
}
