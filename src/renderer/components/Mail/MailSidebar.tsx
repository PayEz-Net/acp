import { useState, useEffect } from 'react';
import { CheckCheck, FolderOpen, Loader2, Mail, MailOpen, RefreshCw, X, ArrowLeft, AlertTriangle, Info } from 'lucide-react';
import { AgentState, MailMessage } from '@shared/types';
import { useMail } from '../../hooks/useMail';
import { useProjectStore } from '../../stores/projectStore';
import { useMailStore, markMessageRead } from '../../stores/mailStore';
import { MailAgentSection } from './MailAgentSection';
import { MailDetail } from './MailDetail';

interface MailSidebarProps {
  agents: AgentState[];
  isOpen: boolean;
  onClose: () => void;
  activeAgent?: string;
}

export function MailSidebar({ agents, isOpen, onClose }: MailSidebarProps) {
  const agentNames = agents.map((a) => a.name);
  const pickerHasStarted = useProjectStore((s) => s.pickerHasStarted);
  const pushConnectionState = useMailStore((s) => s.pushConnectionState);

  const {
    selectedMessageActions,
    selectedMessageSuggested,
    getMessages,
    isLoading,
    selectMessage,
    executeAction,
    refresh,
    markAllRead,
    totalUnread,
    showUnreadOnly,
    toggleUnreadFilter,
  } = useMail({
    agents: agentNames,
    pollInterval: 30000,
    enabled: isOpen && pickerHasStarted,
  });
  const selectedMessage = useMailStore((s) => s.selectedMessage);

  const [markingAll, setMarkingAll] = useState(false);
  const [activeTab, setActiveTab] = useState<'attention' | 'chatter'>('attention');

  // Auto-mark info-tier scout chatter as read on arrival so it does not bump
  // the unread count or interrupt workflow.
  useEffect(() => {
    if (!isOpen) return;
    for (const agent of agents) {
      for (const msg of getMessages(agent.name)) {
        if (msg.importance === 'info' && !msg.is_read) {
          markMessageRead(msg.message_id).then((ok) => {
            if (ok) useMailStore.getState().markAsRead(msg.message_id);
          });
        }
      }
    }
  }, [isOpen, agents, getMessages]);

  const handleMarkAllRead = async () => {
    if (markingAll || totalUnread === 0) return;
    setMarkingAll(true);
    try {
      await markAllRead();
    } finally {
      setMarkingAll(false);
    }
  };

  const attentionMessagesByAgent = agents.map((agent) => ({
    agent,
    messages: getMessages(agent.name).filter((m) => m.importance !== 'info'),
    unreadCount: getMessages(agent.name).filter((m) => m.importance !== 'info' && !m.is_read).length,
  }));

  const chatterMessagesByAgent = agents.map((agent) => ({
    agent,
    messages: getMessages(agent.name).filter((m) => m.importance === 'info'),
    unreadCount: 0,
  }));

  const hasAttention = attentionMessagesByAgent.some((g) => g.messages.length > 0);
  const hasChatter = chatterMessagesByAgent.some((g) => g.messages.length > 0);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 w-[360px] bg-acp-surface border-l border-acp-border z-50 flex flex-col shadow-2xl">
        {selectedMessage ? (
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-4 py-3 border-b border-acp-border bg-acp-surface-raised shrink-0">
              <button
                onClick={() => selectMessage(null)}
                className="flex items-center gap-1 text-sm text-acp-text-secondary hover:text-acp-text-primary transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>
              <button
                onClick={onClose}
                className="p-1.5 text-acp-text-muted hover:text-acp-text-primary hover:bg-acp-surface-raised rounded transition-colors"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <MailDetail
                message={selectedMessage}
                actions={selectedMessageActions}
                suggested={selectedMessageSuggested}
                onClose={() => selectMessage(null)}
                onAction={executeAction}
              />
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-acp-border bg-acp-surface-raised shrink-0">
              <div className="flex items-center gap-2">
                <Mail className="w-5 h-5 text-acp-accent" />
                <span className="text-sm font-semibold text-acp-text-primary">Mail</span>
                {pushConnectionState !== 'connected' && (() => {
                  const isOff = pushConnectionState === 'disconnected';
                  return (
                    <span
                      className="flex items-center gap-1 text-[10px] uppercase tracking-wide"
                      title={`Mail push: ${pushConnectionState}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${isOff ? 'bg-acp-status-error' : 'bg-acp-status-busy animate-pulse'}`} />
                      <span className={isOff ? 'text-acp-status-error' : 'text-acp-status-busy'}>
                        {isOff ? 'Offline' : 'Reconnecting'}
                      </span>
                    </span>
                  );
                })()}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={toggleUnreadFilter}
                  className={`p-1.5 rounded transition-colors ${showUnreadOnly ? 'text-acp-accent bg-acp-accent/10' : 'text-acp-text-muted hover:text-acp-text-primary hover:bg-acp-surface-raised'}`}
                  title={showUnreadOnly ? 'Show all messages' : 'Show unread only'}
                >
                  {showUnreadOnly ? <Mail className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />}
                </button>
                <button
                  onClick={handleMarkAllRead}
                  disabled={markingAll || totalUnread === 0}
                  className="p-1.5 text-acp-text-muted hover:text-acp-accent hover:bg-acp-surface-raised rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title={totalUnread === 0 ? 'No unread messages' : `Mark all ${totalUnread} read (this project)`}
                >
                  {markingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCheck className="w-4 h-4" />}
                </button>
                <button
                  onClick={refresh}
                  className="p-1.5 text-acp-text-muted hover:text-acp-text-primary hover:bg-acp-surface-raised rounded transition-colors"
                  title="Refresh"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
                <button
                  onClick={onClose}
                  className="p-1.5 text-acp-text-muted hover:text-acp-text-primary hover:bg-acp-surface-raised rounded transition-colors"
                  title="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Project Banner */}
            <div className="flex items-center gap-2 px-4 py-2 bg-acp-surface-raised/50 border-b border-acp-border">
              <FolderOpen className="w-3.5 h-3.5 text-acp-status-idle" />
              <span className="text-xs font-semibold text-acp-status-idle uppercase tracking-wider">
                {useProjectStore.getState().activeProject?.name || 'ACP'}
              </span>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-acp-border shrink-0">
              <button
                onClick={() => setActiveTab('attention')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                  activeTab === 'attention'
                    ? 'text-acp-text-primary border-b-2 border-acp-accent bg-acp-surface-raised'
                    : 'text-acp-text-muted hover:text-acp-text-secondary'
                }`}
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                Needs attention
                {totalUnread > 0 && (
                  <span className="px-1.5 py-0.5 text-[10px] font-bold bg-acp-status-error text-white rounded-full">
                    {totalUnread}
                  </span>
                )}
              </button>
              <button
                onClick={() => setActiveTab('chatter')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                  activeTab === 'chatter'
                    ? 'text-acp-text-primary border-b-2 border-acp-accent bg-acp-surface-raised'
                    : 'text-acp-text-muted hover:text-acp-text-secondary'
                }`}
              >
                <Info className="w-3.5 h-3.5" />
                Scout chatter
              </button>
            </div>

            {/* Message list */}
            <div className="flex-1 overflow-y-auto">
              {activeTab === 'attention' ? (
                <>
                  {!hasAttention && (
                    <div className="flex flex-col items-center justify-center h-full text-center p-8 text-acp-text-muted">
                      <MailOpen className="w-10 h-10 mb-3 opacity-30" />
                      <p className="text-sm">No messages need attention.</p>
                    </div>
                  )}
                  {attentionMessagesByAgent.map(({ agent, messages, unreadCount }) => (
                    <MailAgentSection
                      key={agent.name}
                      agent={agent.name}
                      messages={messages}
                      unreadCount={unreadCount}
                      isLoading={isLoading(agent.name)}
                      selectedMessageId={(selectedMessage as MailMessage | null)?.message_id}
                      onSelectMessage={selectMessage}
                      color={agent.color}
                      status={agent.status}
                    />
                  ))}
                </>
              ) : (
                <>
                  {!hasChatter && (
                    <div className="flex flex-col items-center justify-center h-full text-center p-8 text-acp-text-muted">
                      <Info className="w-10 h-10 mb-3 opacity-30" />
                      <p className="text-sm">No scout chatter yet.</p>
                    </div>
                  )}
                  {chatterMessagesByAgent.map(({ agent, messages }) => (
                    <MailAgentSection
                      key={agent.name}
                      agent={agent.name}
                      messages={messages}
                      unreadCount={0}
                      isLoading={isLoading(agent.name)}
                      selectedMessageId={(selectedMessage as MailMessage | null)?.message_id}
                      onSelectMessage={selectMessage}
                      color={agent.color}
                      status={agent.status}
                    />
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
