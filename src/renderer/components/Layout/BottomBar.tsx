import { useEffect } from 'react';
import { Mail, FileText, ClipboardList, Settings, LayoutList, FolderOpen, History } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { useDocumentStore } from '../../stores/documentStore';
import { useMailStore } from '../../stores/mailStore';

export function BottomBar() {
  const { showSidebar, toggleSidebar, showKanban, toggleKanban, showStandup, toggleStandup, showLogs, toggleLogs, showReplay, toggleReplay } = useAppStore();
  const { showDocuments, toggleDocuments, documents } = useDocumentStore();
  const { showSettings, setShowSettings, activeProject } = useProjectStore();
  const { mailboxes } = useMailStore();

  // Global mission-control shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      switch (e.key.toLowerCase()) {
        case 'm':
          e.preventDefault();
          toggleSidebar();
          break;
        case 'l':
          e.preventDefault();
          toggleLogs();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar, toggleLogs]);

  // Unread count scoped to active project and excluding info-tier scout chatter.
  const totalUnread = (() => {
    if (!activeProject) {
      return Object.values(mailboxes).reduce(
        (sum, mb) => sum + (mb?.messages?.filter((m) => !m.is_read && m.importance !== 'info').length || 0),
        0
      );
    }
    const prefix = `${activeProject.id}:`;
    return Object.entries(mailboxes).reduce((sum, [key, mb]) => {
      if (!key.startsWith(prefix)) return sum;
      return sum + (mb?.messages?.filter((m) => !m.is_read && m.importance !== 'info').length || 0);
    }, 0);
  })();

  const toggleSettings = () => setShowSettings(!showSettings);

  const items = [
    {
      id: 'mail',
      icon: Mail,
      label: 'Mail',
      active: showSidebar,
      onClick: toggleSidebar,
      badge: totalUnread > 0 ? (totalUnread > 9 ? '9+' : String(totalUnread)) : undefined,
    },
    {
      id: 'logs',
      icon: FileText,
      label: 'Logs',
      active: showLogs,
      onClick: toggleLogs,
    },
    {
      id: 'documents',
      icon: FolderOpen,
      label: 'Docs',
      active: showDocuments,
      onClick: toggleDocuments,
      badge: documents.length > 0 && !showDocuments ? (documents.length > 9 ? '9+' : String(documents.length)) : undefined,
    },
    {
      id: 'standup',
      icon: ClipboardList,
      label: 'Standup',
      active: showStandup,
      onClick: toggleStandup,
    },
    {
      id: 'kanban',
      icon: LayoutList,
      label: 'Kanban',
      active: showKanban,
      onClick: toggleKanban,
    },
    {
      id: 'replay',
      icon: History,
      label: 'Replay',
      active: showReplay,
      onClick: toggleReplay,
    },
    {
      id: 'settings',
      icon: Settings,
      label: 'Settings',
      active: showSettings,
      onClick: toggleSettings,
    },
  ];

  return (
    <div className="h-10 shrink-0 bg-acp-surface border-t border-acp-border flex items-center px-3 gap-1">
      {items.map(({ id, icon: Icon, label, active, onClick, badge }) => (
        <button
          key={id}
          onClick={onClick}
          className={`
            relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors
            ${active
              ? 'bg-acp-accent text-white'
              : 'text-acp-text-secondary hover:text-acp-text-primary hover:bg-acp-surface-raised'
            }
          `}
          title={label}
        >
          <Icon className="w-3.5 h-3.5" />
          <span>{label}</span>
          {badge && (
            <span className="absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center text-[10px] font-bold bg-acp-status-error text-white rounded-full">
              {badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
