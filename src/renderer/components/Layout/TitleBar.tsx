import { useState } from 'react';
import { Minus, Square, X, Bot, Grid3X3, Columns, PanelLeft, Mail, Radio, FileText, LayoutList, ClipboardList, User, FolderOpen, ChevronDown, Zap, Settings } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore, AuthFlowState } from '../../stores/authStore';
import { useMailStore } from '../../stores/mailStore';
import { useDocumentStore } from '../../stores/documentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAutonomyStore } from '../../stores/autonomyStore';
import { UnattendedConfigModal } from '../Autonomy/UnattendedConfigModal';
import { NotificationCenter } from '../Notifications/NotificationCenter';
import { LayoutMode } from '@shared/types';
import { EnvIndicator } from './EnvIndicator';

export function TitleBar() {
  // Chat / Contractors / Team Editor / Team Builder toggles removed from the
  // destructure — their toolbar entries are hidden (WO #47, ACP read-only).
  // Re-add the names here when restoring those buttons.
  const { layout, setLayout, showSidebar, toggleSidebar, showKanban, toggleKanban, showStandup, toggleStandup, backendAvailable } = useAppStore();
  const { unattended, stopUnattended } = useAutonomyStore();
  const [showConfig, setShowConfig] = useState(false);
  const { user, authFlowState } = useAuthStore();
  // Auth-status indicator (WO: in-app re-login). 🔴 = session died mid-use
  // (SESSION_EXPIRED) or a re-login attempt failed (ERROR, with user still set);
  // 🟡 = re-login in flight; 🟢 = live. When expired, App.tsx renders the
  // SessionExpiredOverlay in-place so the user can sign back in without
  // unmounting agent panes.
  const authExpired =
    authFlowState === AuthFlowState.SESSION_EXPIRED || authFlowState === AuthFlowState.ERROR;
  const authRefreshing = authFlowState === AuthFlowState.AUTHENTICATING;
  const { mailboxes } = useMailStore();
  const { showDocuments, toggleDocuments, documents } = useDocumentStore();
  // setShowSettings removed — Project Settings (editing) is hidden (WO #47).
  const { activeProject, setShowPicker, showSettings, setShowSettings } = useProjectStore();

  // Calculate total unread scoped to active project (QAPert L2 landmine fix)
  const totalUnread = (() => {
    if (!activeProject) {
      return Object.values(mailboxes).reduce((sum, mb) => sum + (mb?.unreadCount || 0), 0);
    }
    const prefix = `${activeProject.id}:`;
    return Object.entries(mailboxes).reduce((sum, [key, mb]) => {
      if (key.startsWith(prefix)) return sum + (mb?.unreadCount || 0);
      return sum;
    }, 0);
  })();

  const layouts: { mode: LayoutMode; icon: typeof Grid3X3; label: string }[] = [
    { mode: 'grid', icon: Grid3X3, label: 'Grid' },
    { mode: 'focus-left', icon: PanelLeft, label: 'Focus Left' },
    { mode: 'focus-right', icon: Columns, label: 'Focus Right' },
  ];

  return (
    <>
    <div className="titlebar h-10 bg-slate-950 border-b border-slate-800 flex items-center justify-between px-3">
      {/* App title + context */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-vibe-500" />
          <span className="text-sm font-semibold text-slate-200">ACP</span>
        </div>
        {/* WO #292: read-only env indicator — persistent, confusion-risk-scaled. */}
        <EnvIndicator />
        <div className="w-px h-4 bg-slate-700" />
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowPicker(true)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>{activeProject?.name || 'No project'}</span>
            <ChevronDown className="w-3 h-3" />
          </button>
          {/* ACP READ-ONLY (Jon D1, WO #47): Project Settings + Edit Team are EDITING — now web-only (the idealvibe workshop). Hidden, not deleted.
              Re-enable: restore this {activeProject && (<>...</>)} block + re-add setShowSettings (useProjectStore) and toggleTeamBuilder (useAppStore) to the destructures + the Settings/Library icon imports. ProjectSettingsPanel + TeamBuilderModal stay wired in App.tsx. */}
        </div>
        {user && (
          <>
            <div className="w-px h-4 bg-slate-700" />
            {authExpired ? (
              // 🔴 Session expired — App.tsx mounts the in-place re-login overlay.
              <div
                title="Session expired — re-login overlay is open"
                className="flex items-center gap-1.5 text-xs font-medium text-red-400"
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-60" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                </span>
                <span>Session expired — Re-login required</span>
              </div>
            ) : (
              <div
                className="flex items-center gap-1.5 text-xs text-slate-500"
                title={authRefreshing ? 'Signing in…' : 'Session live'}
              >
                <span
                  className={`inline-flex rounded-full h-2 w-2 ${
                    authRefreshing ? 'bg-amber-400 animate-pulse' : 'bg-emerald-500'
                  }`}
                  aria-label={authRefreshing ? 'auth refreshing' : 'auth live'}
                />
                <User className="w-3.5 h-3.5" />
                <span>{user.name || user.email}</span>
              </div>
            )}
          </>
        )}
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

      {/* Mode indicator + Sidebar toggles + Window controls */}
      <div className="flex items-center gap-2">
        {/* Notification Center */}
        <NotificationCenter />

        {/* Backend status indicator */}
        <div
          className={`p-2 rounded ${backendAvailable ? 'text-emerald-400' : 'text-red-400'}`}
          title={backendAvailable ? 'Backend: Connected' : 'Backend: Disconnected (mail disabled)'}
        >
          <Radio className={`w-4 h-4 ${backendAvailable ? '' : 'animate-pulse'}`} />
        </div>

        {/* Documents sidebar toggle */}
        <button
          onClick={toggleDocuments}
          className={`relative p-2 rounded transition-colors ${
            showDocuments
              ? 'bg-blue-600 text-white'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
          title="Toggle Documents"
        >
          <FileText className="w-4 h-4" />
          {documents.length > 0 && !showDocuments && (
            <span className="absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center text-[10px] font-bold bg-blue-500 text-white rounded-full">
              {documents.length > 9 ? '9+' : documents.length}
            </span>
          )}
        </button>

        {/* Standup toggle */}
        <button
          onClick={toggleStandup}
          className={`relative p-2 rounded transition-colors ${
            showStandup
              ? 'bg-amber-600 text-white'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
          title="Toggle Standup"
        >
          <ClipboardList className="w-4 h-4" />
        </button>

        {/* Kanban toggle */}
        <button
          onClick={toggleKanban}
          className={`p-2 rounded transition-colors ${
            showKanban
              ? 'bg-cyan-600 text-white'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
          title="Toggle Kanban"
        >
          <LayoutList className="w-4 h-4" />
        </button>

        {/* CHAT HIDDEN for this release (WO #47) — never dev-tested, resurrect later.
            Re-enable: restore this button + re-add showChat/toggleChat (useAppStore) + MessageSquare icon. ChatPanel/chatStore stay intact; App.tsx mounts ChatPanel isOpen={showChat} (default false + unpersisted → unreachable with the button gone). */}

        {/* CONTRACTORS HIDDEN (WO #47, Jon D1: ACP read-only) — contractor hiring/provisioning = agent management, now web-only.
            Re-enable: restore this button + re-add showContractors/toggleContractors (useAppStore) + Briefcase icon. ContractorPanel stays wired in App.tsx. */}

        {/* TEAM EDITOR HIDDEN (WO #47, Jon D1: ACP read-only) — team editing is now web-only.
            Re-enable: restore this button + re-add showTeamEditor/toggleTeamEditor (useAppStore) + Users icon. TeamEditor stays wired in App.tsx. */}

        {/* Unattended Mode — single Zap button: inactive → open config modal, active → toggle panel */}
        <button
          onClick={() => {
            if (unattended.active) {
              stopUnattended('manual');
            } else {
              setShowConfig(true);
            }
          }}
          className={`p-2 rounded transition-colors ${
            unattended.active
              ? 'bg-emerald-600 text-white'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
          title={unattended.active ? 'Unattended mode active — click to stop' : 'Enable unattended mode'}
        >
          <Zap className={`w-4 h-4 ${unattended.active ? 'animate-pulse' : ''}`} />
        </button>

        {/* Mail sidebar toggle */}
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

        {/* Settings toggle */}
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`p-2 rounded transition-colors ${
            showSettings
              ? 'bg-slate-600 text-white'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
          title="Toggle Settings"
        >
          <Settings className="w-4 h-4" />
        </button>

        <div className="w-px h-4 bg-slate-700" />

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
    {showConfig && <UnattendedConfigModal onClose={() => setShowConfig(false)} />}
    </>
  );
}
