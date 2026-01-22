/**
 * Utility functions for vibe-agents-harness renderer
 */

/**
 * Simple class name combiner (replaces clsx + tailwind-merge)
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * Format time ago for display (e.g., "5m ago", "2h ago", "Jan 15")
 */
export function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Get status color class for agent status
 */
export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    offline: 'bg-slate-500',
    starting: 'bg-purple-500',
    ready: 'bg-blue-500',
    busy: 'bg-amber-500',
    idle: 'bg-green-500',
    error: 'bg-red-500',
  };
  return colors[status] || colors.offline;
}
