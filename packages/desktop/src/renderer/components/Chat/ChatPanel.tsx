import { useEffect, useState, useRef } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useAppStore } from '../../stores/appStore';
import { X, Send, Plus, MessageSquare } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface ChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ChatPanel({ isOpen, onClose }: ChatPanelProps) {
  const { conversations, selectedConversation, messages, loading, fetchConversations, selectConversation, sendMessage, startConversation } = useChatStore();
  const { backendAvailable, agents } = useAppStore();
  const [input, setInput] = useState('');
  const [showNewChat, setShowNewChat] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen || !backendAvailable) return;
    fetchConversations();
  }, [isOpen, backendAvailable, fetchConversations]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!isOpen) return null;

  const handleSend = async () => {
    if (!input.trim() || !selectedConversation) return;
    const from = agents[0]?.name || 'Unknown';
    await sendMessage(selectedConversation.id, from, input.trim());
    setInput('');
  };

  const handleNewChat = async (participantName: string) => {
    const myName = agents[0]?.name || 'Unknown';
    const convId = await startConversation([myName, participantName]);
    if (convId) {
      const conv = useChatStore.getState().conversations.find(c => c.id === convId);
      if (conv) await selectConversation(conv);
    }
    setShowNewChat(false);
  };

  const totalUnread = conversations.reduce((sum, c) => sum + c.unreadCount, 0);

  return (
    <div className="w-96 bg-slate-900 border-l border-slate-700 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-semibold text-slate-200">Chat</span>
          {totalUnread > 0 && (
            <span className="text-xs bg-blue-600 text-white px-1.5 rounded-full">{totalUnread}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowNewChat(!showNewChat)} className="text-slate-400 hover:text-emerald-400" title="New Chat">
            <Plus className="w-4 h-4" />
          </button>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
      </div>

      {!backendAvailable ? (
        <div className="p-4 text-sm text-slate-500 text-center">Backend required for chat</div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Conversation List */}
          <div className="w-32 border-r border-slate-800 overflow-y-auto shrink-0">
            {showNewChat && (
              <div className="p-2 border-b border-slate-800">
                <div className="text-xs text-slate-400 mb-1">New chat with:</div>
                {agents.map(a => (
                  <button key={a.id} onClick={() => handleNewChat(a.name)}
                    className="block w-full text-left px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 rounded truncate">
                    {a.name}
                  </button>
                ))}
              </div>
            )}
            {conversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => selectConversation(conv)}
                className={`w-full text-left px-3 py-2 border-b border-slate-800 transition-colors ${
                  selectedConversation?.id === conv.id ? 'bg-slate-800' : 'hover:bg-slate-850'
                }`}
              >
                <div className="text-xs text-slate-200 font-medium truncate">
                  {conv.participants.join(', ')}
                </div>
                {conv.lastMessage && (
                  <div className="text-xs text-slate-500 truncate mt-0.5">{conv.lastMessage.body}</div>
                )}
                {conv.unreadCount > 0 && (
                  <span className="inline-block mt-1 text-xs bg-blue-600 text-white px-1.5 rounded-full">{conv.unreadCount}</span>
                )}
              </button>
            ))}
            {conversations.length === 0 && !loading && (
              <div className="p-3 text-xs text-slate-500 text-center">No conversations</div>
            )}
          </div>

          {/* Message Thread */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {selectedConversation ? (
              <>
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  {messages.map((msg) => (
                    <div key={msg.id} className="text-sm">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-semibold text-slate-300">{msg.from}</span>
                        <span className="text-xs text-slate-600">
                          {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className="text-slate-400 text-xs mt-0.5 prose prose-invert prose-xs max-w-none">
                        <ReactMarkdown>{msg.body}</ReactMarkdown>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>

                {/* Compose */}
                <div className="p-2 border-t border-slate-800">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                      placeholder="Type a message..."
                      className="flex-1 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white placeholder-slate-500 focus:outline-none focus:border-vibe-500"
                    />
                    <button onClick={handleSend} className="p-1.5 bg-blue-600 text-white rounded hover:bg-blue-500" disabled={!input.trim()}>
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-slate-500">
                Select a conversation
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
