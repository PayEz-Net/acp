import { useState, useRef, useEffect } from 'react';
import { useACPStore } from '../../stores/acpStore';
import { ACPAgent, ACP_CHARACTERS, ACPChatMessage } from '@shared/types';

interface AgentDetailPanelProps {
  agent: ACPAgent;
  onClose: () => void;
}

// Stat bar component
function StatBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-[10px] font-bold text-slate-400 uppercase tracking-widest">
        <span>{label}</span>
        <span className="text-cyan-400">{value}%</span>
      </div>
      <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${value}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

// Chat message component
function ChatMessage({ message, agentColor }: { message: ACPChatMessage; agentColor: string }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-lg text-sm ${
          isUser
            ? 'bg-slate-700 text-white'
            : 'bg-slate-800/50 text-slate-200 border-l-2'
        }`}
        style={!isUser ? { borderLeftColor: agentColor } : undefined}
      >
        {message.content}
        {message.streaming && (
          <span className="inline-block w-2 h-4 bg-slate-400 ml-1 animate-pulse" />
        )}
      </div>
    </div>
  );
}

// Mini avatar for sidebar
function MiniAvatar({ color }: { color: string }) {
  return (
    <div
      className="w-14 h-14 rounded-xl bg-slate-800/50 flex items-center justify-center border border-slate-700/50 ring-2 ring-offset-2 ring-offset-slate-900 overflow-hidden"
      style={{ '--tw-ring-color': `${color}50` } as React.CSSProperties}
    >
      <div
        className="w-8 h-8 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 12px ${color}60` }}
      />
    </div>
  );
}

export function AgentDetailPanel({ agent, onClose }: AgentDetailPanelProps) {
  const config = ACP_CHARACTERS[agent.character];
  const {
    chatMessages,
    addChatMessage,
    pauseAgent,
    resumeAgent,
    events,
  } = useACPStore();

  const [inputValue, setInputValue] = useState('');
  const [isExpanded, setIsExpanded] = useState(true);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  const messages = chatMessages.get(agent.id) || [];
  const agentEvents = events
    .filter((e) => e.agentId === agent.id)
    .slice(0, 5);

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!inputValue.trim()) return;

    addChatMessage(agent.id, {
      agentId: agent.id,
      role: 'user',
      content: inputValue.trim(),
    });

    // Simulate agent response (in real implementation, this would call Vercel AI SDK)
    setTimeout(() => {
      addChatMessage(agent.id, {
        agentId: agent.id,
        role: 'assistant',
        content: `I'm ${config.displayName}. I received your message: "${inputValue.trim()}". I'm currently ${agent.status === 'working' ? `working on ${agent.currentTask}` : agent.status}. How can I help?`,
      });
    }, 1000);

    setInputValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePauseResume = () => {
    if (agent.status === 'paused') {
      resumeAgent(agent.id);
    } else {
      pauseAgent(agent.id);
    }
  };

  return (
    <aside className="w-80 bg-[#151D2F] border-l border-slate-800 flex flex-col overflow-hidden z-50">
      {/* Header */}
      <div className="p-4 border-b border-slate-800/50">
        <div className="flex items-start gap-3">
          <MiniAvatar color={config.color} />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-tighter">
              Agent
            </div>
            <h2 className="text-lg font-bold text-white leading-tight truncate">
              {config.displayName} {config.title}
            </h2>
            <p className="text-xs font-medium" style={{ color: config.color }}>
              {config.traits.join(' / ')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Status & Controls */}
        <div className="flex items-center gap-2 mt-3">
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
              agent.status === 'working'
                ? 'bg-emerald-500/20 text-emerald-400'
                : agent.status === 'blocked'
                ? 'bg-orange-500/20 text-orange-400'
                : agent.status === 'paused'
                ? 'bg-yellow-500/20 text-yellow-400'
                : 'bg-slate-700 text-slate-300'
            }`}
          >
            {agent.status}
          </span>
          {agent.currentTask && (
            <span className="text-[10px] text-slate-500 truncate flex-1">
              {agent.currentTask}
            </span>
          )}
          <button
            onClick={handlePauseResume}
            className={`p-1.5 rounded text-xs font-bold transition-colors ${
              agent.status === 'paused'
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : 'bg-yellow-600 hover:bg-yellow-500 text-white'
            }`}
            title={agent.status === 'paused' ? 'Resume' : 'Pause'}
          >
            {agent.status === 'paused' ? (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Stats (collapsible) */}
      <div className="border-b border-slate-800/50">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full px-4 py-2 flex items-center justify-between text-[10px] font-bold text-slate-500 uppercase tracking-widest hover:bg-slate-800/30"
        >
          <span>Stats</span>
          <svg
            className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {isExpanded && (
          <div className="px-4 pb-4 space-y-3">
            <StatBar label="Speed" value={config.stats.speed} color={config.color} />
            <StatBar label="Creativity" value={config.stats.creativity} color={config.color} />
            <StatBar label="Precision" value={config.stats.precision} color={config.color} />
            <StatBar label="Intel" value={config.stats.intel} color={config.color} />
          </div>
        )}
      </div>

      {/* Quote */}
      <div className="px-4 py-3 border-b border-slate-800/50">
        <div
          className="bg-slate-800/40 p-3 rounded-lg border-l-4"
          style={{ borderLeftColor: config.color }}
        >
          <p className="text-xs italic text-slate-300">"{config.quote}"</p>
        </div>
      </div>

      {/* Chat Interface */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-4 py-2 border-b border-slate-800/50">
          <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
            Chat with {config.displayName}
          </h3>
        </div>

        {/* Messages */}
        <div
          ref={chatContainerRef}
          className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
        >
          {messages.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-slate-500 text-sm">
                Start a conversation with {config.displayName}
              </p>
              <p className="text-slate-600 text-xs mt-1">
                Tap to interrupt or give new context
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} agentColor={config.color} />
            ))
          )}
        </div>

        {/* Input */}
        <div className="p-3 border-t border-slate-800/50">
          <div className="flex gap-2">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Message ${config.displayName}...`}
              className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
            />
            <button
              onClick={handleSend}
              disabled={!inputValue.trim()}
              className="px-3 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Action Log */}
      <div className="border-t border-slate-800/50 max-h-32">
        <div className="px-4 py-2">
          <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
            Action Log
          </h3>
          <div className="space-y-2 max-h-20 overflow-y-auto">
            {agentEvents.map((event) => (
              <div key={event.id} className="flex gap-2 text-xs">
                <div
                  className="w-1 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor:
                      event.type === 'agent_completed'
                        ? '#10b981'
                        : event.type === 'agent_blocked'
                        ? '#f59e0b'
                        : '#475569',
                  }}
                />
                <p className="text-slate-400">
                  <span className="text-white">
                    {event.timestamp.toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>{' '}
                  {event.message}
                </p>
              </div>
            ))}
            {agentEvents.length === 0 && (
              <p className="text-slate-600 text-xs">No recent activity</p>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
