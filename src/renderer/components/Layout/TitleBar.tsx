import { Minus, Square, X, Bot, Grid3X3, Columns, PanelLeft, Mail } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useMailStore } from '../../stores/mailStore';
import { LayoutMode } from '@shared/types';

export function TitleBar() {
  const { layout, setLayout, showSidebar, toggleSidebar } = useAppStore();
  const { mailboxes } = useMailStore();

  // Calculate total unread
  const totalUnread = Object.values(mailboxes).reduce(
    (sum, mb) => sum + (mb?.unreadCount || 0),
    0
  );

  const layouts: { mode: LayoutMode; icon: typeof Grid3X3; label: string }[] = [
    { mode: 'grid', icon: Grid3X3, label: 'Grid' },
    { mode: 'focus-left', icon: PanelLeft, label: 'Focus Left' },
    { mode: 'focus-right', icon: Columns, label: 'Focus Right' },
  ];

  return (
    <div className="titlebar h-10 bg-slate-950 border-b border-slate-800 flex items-center justify-between px-3">
      {/* App title */}
      <div className="flex items-center gap-2">
        <Bot className="w-5 h-5 text-vibe-500" />
        <span className="text-sm font-semibold text-slate-200">Vibe Agents Harness</span>
      </div>

      {/* Layout switcher */}
      <div className="flex items-center gap-1 bg-slate-900 rounded-lg p-1">
        {layouts.map(({ mode, icon: Icon, label }) => (
          <button
            key={mode}
            onClick={() => setLayout(mode)}
            className={`p-1.5 rounded transition-colors ${
              layout === mode
                ? 'bg-vibe-600 text-white'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
            title={label}
          >
            <Icon className="w-4 h-4" />
          </button>
        ))}
      </div>

      {/* Mail toggle + Window controls */}
      <div className="flex items-center gap-1">
        {/* Mail toggle */}
        <button
          onClick={toggleSidebar}
          className={`relative p-2 rounded transition-colors ${
            showSidebar
              ? 'bg-violet-600 text-white'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
          title="Toggle Mail (Ctrl+Shift+M)"
        >
          <Mail className="w-4 h-4" />
          {totalUnread > 0 && !showSidebar && (
            <span className="absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center text-[10px] font-bold bg-violet-500 text-white rounded-full">
              {totalUnread > 9 ? '9+' : totalUnread}
            </span>
          )}
        </button>

        <div className="w-px h-4 bg-slate-700 mx-1" />

        <button
          onClick={() => window.electronAPI.minimizeWindow()}
          className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
        >
          <Minus className="w-4 h-4" />
        </button>
        <button
          onClick={() => window.electronAPI.maximizeWindow()}
          className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
        >
          <Square className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => window.electronAPI.closeWindow()}
          className="p-2 text-slate-400 hover:text-white hover:bg-red-600 rounded transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
