import { useEffect, useRef, useState } from 'react';
import { X, Trash2, Pause, Play, ChevronDown, Terminal } from 'lucide-react';
import { useAgentOutputStore } from '../../stores/agentOutputStore';
import { useAppStore } from '../../stores/appStore';
import { ThinkingBlock } from '../ThinkingBlock';
import { providerBadgeClasses, providerLabel, type CodeProvider } from '../../lib/agentProviders';

interface AgentOutputPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AgentOutputPanel({ isOpen, onClose }: AgentOutputPanelProps) {
  const { lines, paused, selectedAgent, setPaused, setSelectedAgent, clear } = useAgentOutputStore();
  const { agents, settings } = useAppStore();
  const showThinking = settings.showThinking !== false;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showNewOutput, setShowNewOutput] = useState(false);

  // Auto-scroll to bottom when new lines arrive, unless paused.
  useEffect(() => {
    if (!isOpen) return;
    if (paused) {
      setShowNewOutput(true);
      return;
    }
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    setShowNewOutput(false);
  }, [lines, isOpen, paused]);

  // Track scroll position to pause/resume automatically.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom && paused) {
      setPaused(false);
      setShowNewOutput(false);
    } else if (!nearBottom && !paused) {
      setPaused(true);
    }
  };

  const filtered = selectedAgent
    ? lines.filter((l) => l.agent === selectedAgent)
    : lines;

  const agentNames = Array.from(new Set(lines.map((l) => l.agent)));

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
          const provider = agent?.provider as CodeProvider | undefined;
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
        className="flex-1 overflow-y-auto p-3 space-y-1 text-sm font-mono relative"
      >
        {filtered.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-2">
            <Terminal className="w-8 h-8 opacity-30" />
            <p className="text-xs">Agent terminal output will appear here.</p>
          </div>
        )}

        {filtered.map((line, idx) => {
          const agent = agents.find((a) => a.name === line.agent);
          const provider = (line.provider || agent?.provider) as CodeProvider | undefined;
          // Live thinking placeholders are updated in-place by the store.
          // Use a stable key so React reconciles the same DOM node instead of
          // remounting it on every spinner frame.
          const key = line.thinkingLive
            ? `${line.agent}-${line.terminal_id ?? 'none'}-thinking`
            : `${line.ts}-${idx}`;
          return (
            <div
              key={key}
              className="flex flex-col py-0.5 hover:bg-slate-800/50 rounded px-1 -mx-1"
            >
              <div className="flex items-start gap-2">
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wide shrink-0 rounded px-1 py-0.5 h-fit ${
                    provider ? providerBadgeClasses(provider) : 'bg-slate-700 text-slate-300'
                  }`}
                >
                  {line.agent}
                </span>
                <span className="text-slate-300 min-w-0 whitespace-pre-wrap leading-tight [overflow-wrap:anywhere]">
                  {line.line}
                </span>
              </div>
              {showThinking && line.thinking !== undefined && (
                <div className="ml-14 mt-1">
                  <ThinkingBlock
                    label={line.thinkingLive ? line.line : 'Thinking'}
                    content={line.thinking}
                    live={line.thinkingLive}
                  />
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* New-output pill */}
      {showNewOutput && paused && (
        <button
          onClick={() => {
            setPaused(false);
            setShowNewOutput(false);
            const el = scrollRef.current;
            if (el) {
              el.scrollTop = el.scrollHeight;
            }
          }}
          className="absolute bottom-4 right-4 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 shadow-lg cursor-pointer"
        >
          <ChevronDown className="w-3.5 h-3.5" />
          New output
        </button>
      )}
    </div>
  );
}
