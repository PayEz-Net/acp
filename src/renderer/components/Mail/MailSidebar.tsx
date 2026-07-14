import { useState } from 'react';
import { CheckCheck, FolderOpen, Loader2, Mail, MailOpen, RefreshCw, X } from 'lucide-react';
import { AgentState, MailMessage } from '@shared/types';
import { useMail } from '../../hooks/useMail';
import { useProjectStore } from '../../stores/projectStore';
import { useMailStore } from '../../stores/mailStore';
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
    getUnreadCount,
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

  const handleMarkAllRead = async () => {
    if (markingAll || totalUnread === 0) return;
    setMarkingAll(true);
    try {
      await markAllRead();
    } finally {
      setMarkingAll(false);
    }
  };

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
      <div className="fixed right-0 top-0 bottom-0 w-[600px] bg-acp-surface border-l border-acp-border z-50 flex shadow-2xl">
        {/* Mail List */}
        <div className="w-72 flex flex-col border-r border-acp-border">
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

          {/* Agent Sections */}
          <div className="flex-1 overflow-y-auto">
            {agents.map((agent) => (
              <MailAgentSection
                key={agent.name}
                agent={agent.name}
                messages={getMessages(agent.name)}
                unreadCount={getUnreadCount(agent.name)}
                isLoading={isLoading(agent.name)}
                selectedMessageId={(selectedMessage as MailMessage | null)?.message_id}
                onSelectMessage={selectMessage}
                color={agent.color}
                status={agent.status}
              />
            ))}
          </div>
        </div>

        {/* Detail Pane */}
        <div className="flex-1 flex flex-col min-w-0 bg-acp-surface">
          {selectedMessage ? (
            <MailDetail
              message={selectedMessage}
              actions={selectedMessageActions}
              suggested={selectedMessageSuggested}
              onClose={() => selectMessage(null)}
              onAction={executeAction}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <Mail className="w-12 h-12 text-acp-text-muted/30 mb-4" />
              <p className="text-sm text-acp-text-muted">
                Select a message to view
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
