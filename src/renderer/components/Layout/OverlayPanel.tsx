import { ReactNode } from 'react';

interface OverlayPanelProps {
  isOpen: boolean;
  onClose: () => void;
  width?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Right-side drawer overlay used by nav popouts (Mail, Kanban, Docs, Logs, etc.).
 * Mirrors MailSidebar: fixed drawer over a dimmed backdrop so the terminal grid
 * stays visible underneath instead of being pushed aside.
 */
export function OverlayPanel({
  isOpen,
  onClose,
  width = 'w-[360px]',
  children,
  className = '',
}: OverlayPanelProps) {
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
      <div
        className={`fixed right-0 top-0 bottom-0 ${width} bg-acp-surface border-l border-acp-border z-50 flex flex-col shadow-2xl ${className}`}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </>
  );
}
