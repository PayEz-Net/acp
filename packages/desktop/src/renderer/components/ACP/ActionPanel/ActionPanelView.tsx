import { useEffect, useCallback } from 'react';
import { ActionPanel, PanelAction } from '@shared/types';
import { ActionButton } from './ActionButton';

interface ActionPanelViewProps<T> {
  panel: ActionPanel<T>;
  onAction: (action: PanelAction) => void;
  renderData?: (data: T) => React.ReactNode;
  className?: string;
}

/**
 * Renders an ActionPanel with data, suggested action, and action buttons.
 * Handles keyboard shortcuts for actions with `key` defined.
 */
export function ActionPanelView<T>({
  panel,
  onAction,
  renderData,
  className = '',
}: ActionPanelViewProps<T>) {
  // Find suggested action
  const suggestedAction = panel.suggested
    ? panel.actions.find((a) => panel.suggested?.startsWith(a.action))
    : null;

  // Keyboard shortcut handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // Find action matching this key
      const action = panel.actions.find(
        (a) => a.key?.toLowerCase() === e.key.toLowerCase() && !a.disabled
      );

      if (action) {
        e.preventDefault();
        onAction(action);
      }
    },
    [panel.actions, onAction]
  );

  // Register keyboard shortcuts
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Status badge colors
  const statusColors = {
    success: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    error: 'bg-red-500/20 text-red-400 border-red-500/30',
    warning: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    info: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  };

  return (
    <div
      className={`bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden ${className}`}
    >
      {/* Header */}
      {(panel.title || panel.status) && (
        <div className="px-4 py-3 border-b border-slate-700/50 flex items-center justify-between">
          {panel.title && (
            <h3 className="text-sm font-bold text-white">{panel.title}</h3>
          )}
          {panel.status && (
            <span
              className={`px-2 py-0.5 text-xs font-medium rounded border ${statusColors[panel.status]}`}
            >
              {panel.statusMessage || panel.status}
            </span>
          )}
        </div>
      )}

      {/* Data section */}
      <div className="p-4">
        {renderData ? (
          renderData(panel.data)
        ) : (
          <pre className="text-xs text-slate-400 overflow-auto max-h-64 bg-slate-900/50 p-3 rounded-lg">
            {JSON.stringify(panel.data, null, 2)}
          </pre>
        )}
      </div>

      {/* Suggested action highlight */}
      {panel.suggested && (
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 px-3 py-2 bg-cyan-500/10 border border-cyan-500/20 rounded-lg">
            <svg
              className="w-4 h-4 text-cyan-400 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 7l5 5m0 0l-5 5m5-5H6"
              />
            </svg>
            <span className="text-xs text-cyan-300">
              <span className="font-medium">Suggested:</span> {panel.suggested}
            </span>
          </div>
        </div>
      )}

      {/* Actions */}
      {panel.actions.length > 0 && (
        <div className="px-4 pb-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
              Actions
            </span>
            <div className="flex-1 h-px bg-slate-700/50" />
          </div>
          <div className="flex flex-wrap gap-2">
            {panel.actions.map((action) => (
              <ActionButton
                key={action.action}
                action={action}
                onExecute={onAction}
                isSuggested={suggestedAction?.action === action.action}
              />
            ))}
          </div>
        </div>
      )}

      {/* Keyboard hints footer */}
      {panel.actions.some((a) => a.key && !a.disabled) && (
        <div className="px-4 py-2 bg-slate-900/30 border-t border-slate-700/30">
          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            <span className="font-medium uppercase tracking-wide">
              Shortcuts:
            </span>
            {panel.actions
              .filter((a) => a.key && !a.disabled)
              .map((a) => (
                <span key={a.action} className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-slate-800 rounded font-mono">
                    {a.key}
                  </kbd>
                  <span>{a.action}</span>
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Compact inline version for embedding in other components
 */
export function ActionPanelInline<T>({
  panel,
  onAction,
}: {
  panel: ActionPanel<T>;
  onAction: (action: PanelAction) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {panel.actions.slice(0, 4).map((action) => (
        <ActionButton
          key={action.action}
          action={action}
          onExecute={onAction}
          size="sm"
        />
      ))}
      {panel.actions.length > 4 && (
        <span className="text-xs text-slate-500">
          +{panel.actions.length - 4} more
        </span>
      )}
    </div>
  );
}
