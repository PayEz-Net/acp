import { Mail, PenSquare, RefreshCw, X } from 'lucide-react';
import { AgentState } from '@shared/types';
import { useMail } from '../../hooks/useMail';
import { MailAgentSection } from './MailAgentSection';
import { MailDetail } from './MailDetail';
import { ComposeModal } from './ComposeModal';

interface MailSidebarProps {
  agents: AgentState[];
  isOpen: boolean;
  onClose: () => void;
  activeAgent?: string;
}

export function MailSidebar({ agents, isOpen, onClose, activeAgent }: MailSidebarProps) {
  const agentNames = agents.map((a) => a.name);

  const {
    selectedMessage,
    selectedMessageActions,
    selectedMessageSuggested,
    isComposing,
    replyTo,
    totalUnread,
    getUnreadCount,
    getMessages,
    isLoading,
    selectMessage,
    setComposing,
    sendMessage,
    executeAction,
    refresh,
  } = useMail({
    agents: agentNames,
    pollInterval: 30000,
    enabled: isOpen,
  });

  const handleReply = () => {
    if (selectedMessage) {
      setComposing(true, selectedMessage);
    }
  };

  const handleSend = async (to: string, subject: string, body: string) => {
    // Use active agent as sender, or first agent
    const from = activeAgent || agentNames[0] || 'Unknown';
    return sendMessage(from, to, subject, body);
  };

  if (!isOpen) return null;

  return (
    <div className="flex h-full bg-slate-900 border-l border-slate-700">
      {/* Mail List */}
      <div className="w-72 flex flex-col border-r border-slate-800">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-violet-400" />
            <span className="text-sm font-semibold text-slate-200">Mail</span>
            {totalUnread > 0 && (
              <span className="px-1.5 py-0.5 text-xs font-semibold bg-violet-600 text-white rounded-full">
                {totalUnread}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={refresh}
              className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={() => setComposing(true)}
              className="p-1.5 text-slate-400 hover:text-violet-400 hover:bg-slate-800 rounded transition-colors"
              title="Compose"
            >
              <PenSquare className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Agent Sections */}
        <div className="flex-1 overflow-y-auto">
          {agents.map((agent) => (
            <MailAgentSection
              key={agent.name}
              agent={agent.name}
              messages={getMessages(agent.name)}
              unreadCount={getUnreadCount(agent.name)}
              isLoading={isLoading(agent.name)}
              selectedMessageId={selectedMessage?.message_id}
              onSelectMessage={selectMessage}
              color={agent.color}
            />
          ))}
        </div>
      </div>

      {/* Detail Pane */}
      <div className="w-80 flex flex-col">
        {selectedMessage ? (
          <MailDetail
            message={selectedMessage}
            actions={selectedMessageActions}
            suggested={selectedMessageSuggested}
            onClose={() => selectMessage(null)}
            onReply={handleReply}
            onAction={executeAction}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <Mail className="w-12 h-12 text-slate-700 mb-4" />
            <p className="text-sm text-slate-500">
              Select a message to view
            </p>
          </div>
        )}
      </div>

      {/* Compose Modal */}
      {isComposing && (
        <ComposeModal
          fromAgent={activeAgent || agentNames[0] || 'Unknown'}
          replyTo={replyTo}
          agents={agentNames}
          onSend={handleSend}
          onClose={() => setComposing(false)}
        />
      )}
    </div>
  );
}
