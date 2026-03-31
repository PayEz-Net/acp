import { useEffect, useRef } from 'react';
import {
  Bell,
  Mail,
  CheckSquare,
  Eye,
  AtSign,
  Settings,
  X,
  CheckCheck,
  Trash2,
} from 'lucide-react';
import { cn, formatTimeAgo } from '../../utils';
import { useNotificationStore } from '../../stores/notificationStore';
import type { NotificationType } from '@shared/types';

const typeConfig: Record<NotificationType, { icon: typeof Bell; color: string; bg: string }> = {
  mail: { icon: Mail, color: 'text-blue-400', bg: 'bg-blue-400/10' },
  task: { icon: CheckSquare, color: 'text-green-400', bg: 'bg-green-400/10' },
  review: { icon: Eye, color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
  mention: { icon: AtSign, color: 'text-purple-400', bg: 'bg-purple-400/10' },
  system: { icon: Settings, color: 'text-slate-400', bg: 'bg-slate-400/10' },
};

export function NotificationCenter() {
  const {
    notifications,
    unreadCount,
    isOpen,
    toggleOpen,
    setOpen,
    markAsRead,
    markAllAsRead,
    removeNotification,
    clearAll,
  } = useNotificationStore();

  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, setOpen]);

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Button */}
      <button
        onClick={toggleOpen}
        className={cn(
          'relative p-2 rounded transition-colors',
          isOpen
            ? 'text-white bg-slate-700'
            : 'text-slate-400 hover:text-white hover:bg-slate-700'
        )}
        title="Notifications"
      >
        <Bell className="w-5 h-5" />

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-xs font-bold text-white bg-red-500 rounded-full">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50">
          {/* Header */}
          <div className="flex items-center justify-between p-3 border-b border-slate-700">
            <h3 className="font-semibold text-white">Notifications</h3>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  onClick={markAllAsRead}
                  className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
                  title="Mark all as read"
                >
                  <CheckCheck className="w-4 h-4" />
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={clearAll}
                  className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded transition-colors"
                  title="Clear all"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Notification List */}
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-sm">
                No notifications
              </div>
            ) : (
              notifications.map((notification) => {
                const config = typeConfig[notification.type];
                const Icon = config.icon;

                return (
                  <div
                    key={notification.id}
                    className={cn(
                      'flex gap-3 p-3 border-b border-slate-700/50 hover:bg-slate-800/50 transition-colors cursor-pointer',
                      !notification.read && 'bg-slate-800/30'
                    )}
                    onClick={() => markAsRead(notification.id)}
                  >
                    {/* Icon */}
                    <div className={cn('flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center', config.bg)}>
                      <Icon className={cn('w-4 h-4', config.color)} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className={cn(
                          'text-sm truncate',
                          notification.read ? 'text-slate-300' : 'text-white font-medium'
                        )}>
                          {notification.title}
                        </p>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            removeNotification(notification.id);
                          }}
                          className="p-0.5 text-slate-500 hover:text-slate-300 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">
                        {notification.message}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        {notification.agent && (
                          <span className="text-xs text-slate-500">{notification.agent}</span>
                        )}
                        <span className="text-xs text-slate-600">
                          {formatTimeAgo(notification.created_at)}
                        </span>
                      </div>
                    </div>

                    {/* Unread indicator */}
                    {!notification.read && (
                      <div className="flex-shrink-0 w-2 h-2 mt-2 rounded-full bg-blue-500" />
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer */}
          {notifications.length > 0 && (
            <div className="p-2 border-t border-slate-700 text-center">
              <span className="text-xs text-slate-500">
                {notifications.length} notification{notifications.length !== 1 ? 's' : ''}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default NotificationCenter;
