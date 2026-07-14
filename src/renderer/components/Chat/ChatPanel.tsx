import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useChatStore, type ChatMessage } from '../../stores/chatStore';
import { useAppStore } from '../../stores/appStore';
import { X, Plus, MessageSquare, Send } from 'lucide-react';
import { OverlayPanel } from '../Layout/OverlayPanel';
import ReactMarkdown from 'react-markdown';
import { useInputHistory } from '../../hooks/useInputHistory';

interface ChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

function ChatMessageItem({ msg, isMe }: { msg: ChatMessage; isMe: boolean }) {
  return (
    <div className={`flex ${isMe ? 'justify-end' : 'justify-start'}`} data-testid="chat-message">
      <div className={`max-w-[85%] min-w-0 ${isMe ? 'items-end' : 'items-start'}`}>
        <div className={`flex items-baseline gap-2 ${isMe ? 'justify-end' : ''}`}>
          <span className="text-xs font-semibold text-slate-300 truncate">{msg.from}</span>
          <span className="text-[10px] text-slate-600">
            {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div
          className={`mt-0.5 text-sm whitespace-pre-wrap break-words rounded px-2 py-1 ${
            isMe
              ? 'bg-blue-600/20 text-blue-200'
              : 'bg-slate-800/50 text-slate-300 border border-slate-700/50'
          }`}
        >
          <div className="prose prose-invert prose-xs max-w-none">
            <ReactMarkdown>{msg.body}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatPanel({ isOpen, onClose }: ChatPanelProps) {
  const {
    conversations,
    selectedConversation,
    messages,
    loading,
    fetchConversations,
    selectConversation,
    startConversation,
    sendMessage,
  } = useChatStore();
  const { backendAvailable, agents, activeAgentId } = useAppStore();

  const [showNewChat, setShowNewChat] = useState(false);
  const [canSend, setCanSend] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<ChatMessage[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const myName = useMemo(() => {
    const me = agents.find((a) => a.id === activeAgentId);
    return me?.name ?? agents[0]?.name ?? 'Unknown';
  }, [agents, activeAgentId]);

  const history = useInputHistory(myName, selectedConversation?.id);

  useEffect(() => {
    if (!isOpen || !backendAvailable) return;
    fetchConversations();
  }, [isOpen, backendAvailable, fetchConversations]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, optimisticMessages]);

  // Auto-resize the textarea as the user types or pastes.
  const resizeInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 160;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    if (isOpen) resizeInput();
  }, [isOpen, resizeInput]);

  const handleNewChat = async (participantName: string) => {
    const convId = await startConversation([myName, participantName]);
    if (convId) {
      const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
      if (conv) await selectConversation(conv);
    }
    setShowNewChat(false);
  };

  const handleSend = useCallback(async () => {
    const input = inputRef.current;
    if (!selectedConversation || !input) return;
    const body = input.value.trim();
    if (!body) return;

    setSendError(null);
    const tempId = `optimistic-${Date.now()}`;
    const optimistic: ChatMessage = {
      id: tempId,
      conversationId: selectedConversation.id,
      from: myName,
      body,
      createdAt: new Date().toISOString(),
    };
    setOptimisticMessages((prev) => [...prev, optimistic]);
    input.value = '';
    input.style.height = 'auto';
    setCanSend(false);
    history.commit(body);

    const ok = await sendMessage(selectedConversation.id, myName, body);
    setOptimisticMessages((prev) => prev.filter((m) => m.id !== tempId));
    if (!ok) {
      setSendError('Failed to send message.');
      // Restore the input so the user can retry.
      input.value = body;
      resizeInput();
      setCanSend(true);
    }
  }, [selectedConversation, myName, sendMessage, history]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const input = inputRef.current;
      if (!input) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
        return;
      }
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, start) + '\n' + input.value.slice(end);
        input.setSelectionRange(start + 1, start + 1);
        setCanSend(input.value.trim() !== '');
        resizeInput();
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = history.cycle(e.key === 'ArrowUp' ? 'up' : 'down', input.value);
        if (next !== null) {
          input.value = next;
          setCanSend(next.trim() !== '');
          resizeInput();
          requestAnimationFrame(() => {
            input.setSelectionRange(next.length, next.length);
          });
        }
      }
    },
    [handleSend, history, resizeInput],
  );

  const totalUnread = conversations.reduce((sum, c) => sum + c.unreadCount, 0);

  const displayMessages = useMemo(() => {
    // Optimistic messages are appended after the server-known messages so the
    // user sees their own bubble immediately, even before the POST returns.
    return [...messages, ...optimisticMessages];
  }, [messages, optimisticMessages]);

  if (!isOpen) return null;

  return (
    <OverlayPanel isOpen={isOpen} onClose={onClose} width="w-96" className="bg-slate-900 border-slate-700">
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
          <button
            onClick={() => setShowNewChat(!showNewChat)}
            className="text-slate-400 hover:text-emerald-400"
            title="New Chat"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
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
                {agents.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => handleNewChat(a.name)}
                    className="block w-full text-left px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 rounded truncate"
                  >
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
                  <span className="inline-block mt-1 text-xs bg-blue-600 text-white px-1.5 rounded-full">
                    {conv.unreadCount}
                  </span>
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
                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                  {displayMessages.map((msg) => (
                    <ChatMessageItem key={msg.id} msg={msg} isMe={msg.from === myName} />
                  ))}
                  <div ref={messagesEndRef} />
                </div>

                {sendError && (
                  <div className="px-3 py-1 text-xs text-red-400 border-t border-slate-800">{sendError}</div>
                )}

                <div className="shrink-0 border-t border-slate-800 p-2">
                  <div className="flex items-center gap-2 rounded-full bg-slate-800/80 px-3 py-2 border border-slate-700/50 focus-within:border-slate-500 focus-within:ring-1 focus-within:ring-slate-500/30 transition-all">
                    <textarea
                      ref={inputRef}
                      rows={1}
                      defaultValue=""
                      onChange={(e) => {
                        setCanSend(e.target.value.trim() !== '');
                        resizeInput();
                      }}
                      onPaste={() => requestAnimationFrame(resizeInput)}
                      onKeyDown={handleKeyDown}
                      placeholder={`Message ${selectedConversation.participants.filter((p) => p !== myName).join(', ')}…`}
                      className="flex-1 bg-transparent text-slate-200 text-sm placeholder:text-slate-500 outline-none resize-none py-1.5 min-h-[20px] max-h-[160px]"
                      data-testid="chat-input"
                      aria-label="Chat message input"
                    />
                    <button
                      onClick={handleSend}
                      disabled={!canSend}                      className="p-1.5 rounded-full text-slate-400 hover:text-emerald-400 hover:bg-slate-700/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      title="Send"
                      data-testid="chat-send"
                      aria-label="Send message"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="text-[10px] text-slate-600 mt-1 px-1">Enter to send · Shift+Enter for new line · Up/Down arrows recall recent inputs</div>
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
    </OverlayPanel>
  );
}
