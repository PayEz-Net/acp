import { PanelAction } from '@shared/types';

interface ActionButtonProps {
  action: PanelAction;
  onExecute: (action: PanelAction) => void;
  isSuggested?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * A button representing a single action from an ActionPanel.
 * Shows hint, keyboard shortcut, and handles destructive/disabled states.
 */
export function ActionButton({
  action,
  onExecute,
  isSuggested = false,
  size = 'md',
}: ActionButtonProps) {
  const handleClick = () => {
    if (action.disabled) return;

    if (action.destructive) {
      // Could add a confirmation dialog here
      const confirmed = window.confirm(`Are you sure you want to ${action.hint.toLowerCase()}?`);
      if (!confirmed) return;
    }

    onExecute(action);
  };

  const sizeClasses = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-1.5 text-sm',
    lg: 'px-4 py-2 text-base',
  };

  const baseClasses = `
    inline-flex items-center gap-2 rounded-lg font-medium
    transition-all duration-150 ease-out
    focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-900
  `;

  const stateClasses = action.disabled
    ? 'bg-slate-800/50 text-slate-500 cursor-not-allowed'
    : action.destructive
    ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-500/30 focus:ring-red-500'
    : isSuggested
    ? 'bg-cyan-600 text-white hover:bg-cyan-500 shadow-lg shadow-cyan-500/20 focus:ring-cyan-500'
    : 'bg-slate-700 text-slate-200 hover:bg-slate-600 border border-slate-600 focus:ring-slate-500';

  return (
    <button
      onClick={handleClick}
      disabled={action.disabled}
      className={`${baseClasses} ${sizeClasses[size]} ${stateClasses}`}
      title={action.disabled ? action.disabledReason : action.hint}
      aria-label={action.hint}
    >
      {/* Action name */}
      <span>{action.action}</span>

      {/* Keyboard shortcut badge */}
      {action.key && !action.disabled && (
        <kbd className="px-1.5 py-0.5 bg-slate-900/50 rounded text-[10px] font-mono uppercase tracking-wide">
          {action.key}
        </kbd>
      )}

      {/* Destructive indicator */}
      {action.destructive && !action.disabled && (
        <svg className="w-3.5 h-3.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      )}
    </button>
  );
}

/**
 * Compact action button for inline use (just icon + key hint)
 */
export function ActionButtonCompact({
  action,
  onExecute,
}: {
  action: PanelAction;
  onExecute: (action: PanelAction) => void;
}) {
  const handleClick = () => {
    if (action.disabled) return;
    onExecute(action);
  };

  return (
    <button
      onClick={handleClick}
      disabled={action.disabled}
      className={`
        p-1.5 rounded transition-colors
        ${action.disabled
          ? 'text-slate-600 cursor-not-allowed'
          : action.destructive
          ? 'text-red-400 hover:bg-red-500/20'
          : 'text-slate-400 hover:bg-slate-700 hover:text-white'
        }
      `}
      title={action.hint}
      aria-label={action.hint}
    >
      {action.key && (
        <kbd className="text-[10px] font-mono uppercase">{action.key}</kbd>
      )}
    </button>
  );
}
