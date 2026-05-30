import { useState } from 'react';
import { CheckCheck, FolderOpen, Loader2, Mail, MailOpen, RefreshCw, X } from 'lucide-react';
import { AgentState } from '@shared/types';
import { useMail } from '../../hooks/useMail';
import { useProjectStore } from '../../stores/projectStore';
import { MailAgentSection } from './MailAgentSection';
import { MailDetail } from './MailDetail';
// ComposeModal removed: human mail is OBSERVE-ONLY until the rethink (BAPert
// 1369). The never-worked human->agent send (compose + reply) is taken off.

interface MailSidebarProps {
  agents: AgentState[];
  isOpen: boolean;
  onClose: () => void;
  activeAgent?: string;
}

export function MailSidebar({ agents, isOpen, onClose }: MailSidebarProps) {
  const agentNames = agents.map((a) => a.name);
  // Defense-in-depth gate per Ship F-bis (BAPert msg 1052): even though the
  // primary fix is App.tsx no longer hydrating stale agents from electron-
  // store on auth, gate mail polling on current_project_state === 'stored'
  // so any future regression doesn't leak into 30s-cadence agentmail GETs
  // before the picker resolves.
  const currentProjectState = useProjectStore((s) => s.current_project_state);

  const {
    selectedMessage,
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
    enabled: isOpen && currentProjectState === 'stored',
  });

  const [markingAll, setMarkingAll] = useState(false);

  // Mark-all-read for the CURRENT project (BAPert 1310). Clears every agent
  // with unread in one gesture — the human surface for the reliable bulk
  // read-all. Feedback: the unread badges + total drop to 0 on refresh; a
  // failure leaves the un-cleared badges visible (never a silent success).
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
    <div className="flex h-full bg-slate-900 border-l border-slate-700">
      {/* Mail List */}
      <div className="w-72 flex flex-col border-r border-slate-800">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-violet-400" />
            <span className="text-sm font-semibold text-slate-200">Mail</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={toggleUnreadFilter}
              className={`p-1.5 rounded transition-colors ${showUnreadOnly ? 'text-violet-400 bg-violet-900/30' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
              title={showUnreadOnly ? 'Show all messages' : 'Show unread only'}
            >
              {showUnreadOnly ? <Mail className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />}
            </button>
            <button
              onClick={handleMarkAllRead}
              disabled={markingAll || totalUnread === 0}
              className="p-1.5 text-slate-400 hover:text-violet-400 hover:bg-slate-800 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={totalUnread === 0 ? 'No unread messages' : `Mark all ${totalUnread} read (this project)`}
            >
              {markingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCheck className="w-4 h-4" />}
            </button>
            <button
              onClick={refresh}
              className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            {/* Compose (new agent-mail) icon REMOVED per BAPert 1364 / Jon: the
                non-terminal human->agent compose never worked; taken off, NOT
                replaced (Aurum owns the ground-up outside-terminal rethink). */}
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Project Banner */}
        <div className="flex items-center gap-2 px-4 py-2 bg-cyan-950/40 border-b border-cyan-900/50">
          <FolderOpen className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-xs font-semibold text-cyan-300 uppercase tracking-wider">{useProjectStore.getState().activeProject?.name || 'ACP'}</span>
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
              status={agent.status}
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

    </div>
  );
}
