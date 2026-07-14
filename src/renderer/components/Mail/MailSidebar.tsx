import { useCallback } from 'react';
import { CheckCheck, FolderOpen, Mail, MailOpen, RefreshCw, X } from 'lucide-react';
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
    showUnreadOnly,
    toggleUnreadFilter,
  } = useMail({
    agents: agentNames,
    pollInterval: 30000,
    enabled: isOpen && pickerHasStarted,
  });
  const selectedMessage = useMailStore((s) => s.selectedMessage);

  const handleMarkAllRead = useCallback(() => {
    console.log('[MailSidebar] mark all read clicked');
    void markAllRead().catch((err) => {
      console.error('[MailSidebar] mark all read failed:', err);
    });
  }, [markAllRead]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40 no-drag"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer — explicit no-drag so the titlebar drag-region behind it can't
          swallow pointer events for the header controls. */}
      <div className="fixed right-0 top-0 bottom-0 w-[600px] bg-acp-surface border-l border-acp-border z-50 flex shadow-2xl no-drag">
        {/* Mail List */}
        <div className="w-72 flex flex-col border-r border-acp-border">
          {/* Header — rebuilt as text-only controls to avoid the icon-only
              hit-test trap in the titlebar overlap zone. */}
          <div className="no-drag flex items-center justify-between px-4 py-3 border-b border-acp-border bg-acp-surface-raised shrink-0 gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Mail className="w-5 h-5 text-acp-accent shrink-0" />
              <span className="text-sm font-semibold text-acp-text-primary truncate">Mail</span>
              {pushConnectionState !== 'connected' && (() => {
                const isOff = pushConnectionState === 'disconnected';
                return (
                  <span
                    className="flex items-center shrink-0"
                    title={`Mail push: ${pushConnectionState}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${isOff ? 'bg-acp-status-error' : 'bg-acp-status-busy animate-pulse'}`} />
                    <span className="sr-only">{isOff ? 'Offline' : 'Reconnecting'}</span>
                  </span>
                );
              })()}
            </div>
            <div className="no-drag flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={toggleUnreadFilter}
                className={`no-drag appearance-none font-sans p-1.5 rounded transition-colors border ${showUnreadOnly ? 'text-acp-accent bg-acp-accent/10 border-acp-accent/20' : 'text-acp-text-muted bg-transparent hover:text-acp-text-primary hover:bg-acp-surface-raised border-transparent hover:border-acp-border'}`}
                title={showUnreadOnly ? 'Show all messages' : 'Show unread only'}
                aria-label={showUnreadOnly ? 'Show all messages' : 'Show unread only'}
              >
                {showUnreadOnly ? <Mail className="w-4 h-4 pointer-events-none" /> : <MailOpen className="w-4 h-4 pointer-events-none" />}
              </button>
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="no-drag appearance-none font-sans p-1.5 text-acp-text-muted bg-transparent hover:text-acp-text-primary hover:bg-acp-surface-raised rounded transition-colors border border-transparent hover:border-acp-border"
                title="Mark all read (this project)"
                aria-label="Mark all read (this project)"
              >
                <CheckCheck className="w-4 h-4 pointer-events-none" />
              </button>
              <button
                type="button"
                onClick={refresh}
                className="no-drag appearance-none font-sans p-1.5 text-acp-text-muted bg-transparent hover:text-acp-text-primary hover:bg-acp-surface-raised rounded transition-colors border border-transparent hover:border-acp-border"
                title="Refresh"
                aria-label="Refresh"
              >
                <RefreshCw className="w-4 h-4 pointer-events-none" />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="no-drag appearance-none font-sans p-1.5 text-acp-text-muted bg-transparent hover:text-acp-text-primary hover:bg-acp-surface-raised rounded transition-colors border border-transparent hover:border-acp-border"
                title="Close"
                aria-label="Close"
              >
                <X className="w-4 h-4 pointer-events-none" />
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
