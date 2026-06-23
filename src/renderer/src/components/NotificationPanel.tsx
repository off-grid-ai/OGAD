import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { IconBell, IconX, IconShieldCheck, IconChecklist, IconCheck, IconTrash, IconArrowRight } from '@tabler/icons-react';
import { useNotifications, Notification } from '../hooks/useNotifications';
import { cn } from '@renderer/lib/utils';
import { ProgressiveBlur } from './ui/progressive-blur';

interface NotificationPanelProps {
  /** Open the Actions / Approvals screen (where approvals and to-dos live). */
  onOpenActions?: () => void;
  onViewAll?: () => void;
}

function getNotificationIcon(type: Notification['type']) {
  const iconClass = "h-4 w-4 text-neutral-500";
  switch (type) {
    case 'approval':
      return <IconShieldCheck className={iconClass} />;
    case 'todo':
      return <IconChecklist className={iconClass} />;
    default:
      return <IconBell className={iconClass} />;
  }
}

function formatTimestamp(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  
  return date.toLocaleDateString();
}

export function NotificationPanel({ onOpenActions, onViewAll }: NotificationPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearNotification, clearAll } = useNotifications();

  // Close panel when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
    return undefined;
  }, [isOpen]);

  const handleNotificationClick = (notification: Notification) => {
    markAsRead(notification.id);
    // Both approvals and to-dos live on the Actions screen.
    onOpenActions?.();
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={panelRef}>
      {/* Notification Bell Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "relative h-[42px] w-[42px] rounded-xl border border-neutral-800/60 bg-neutral-900/50",
          "text-neutral-500 hover:text-neutral-300 hover:border-neutral-700",
          "flex items-center justify-center transition-all",
          isOpen && "border-neutral-700 text-neutral-300"
        )}
        aria-label="Notifications"
      >
        <IconBell className="h-5 w-5" />
        
        {/* Unread Badge */}
        <AnimatePresence>
          {unreadCount > 0 && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              className={cn(
                "absolute -top-1 -right-1 flex items-center justify-center",
                "min-w-[16px] h-[16px] px-1 text-[9px] font-medium",
                "bg-neutral-700 text-neutral-200 rounded-full",
                "border border-neutral-800"
              )}
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      {/* Notification Panel Dropdown */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -8, filter: 'blur(4px)' }}
            transition={{ duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94] }}
            className={cn(
              "absolute right-0 top-full mt-2 z-50",
              "w-[340px] max-h-[480px] overflow-hidden",
              "bg-neutral-950/95 backdrop-blur-xl rounded-xl",
              "border border-neutral-800/60"
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800/60">
              <span className="text-[11px] font-normal uppercase tracking-widest text-neutral-500">
                Notifications
              </span>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllAsRead}
                    className="h-7 w-7 rounded-lg border border-neutral-800/60 bg-transparent text-neutral-600 hover:text-neutral-300 hover:border-neutral-700 transition-all flex items-center justify-center"
                    title="Mark all as read"
                  >
                    <IconCheck className="h-3.5 w-3.5" />
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    onClick={clearAll}
                    className="h-7 w-7 rounded-lg border border-neutral-800/60 bg-transparent text-neutral-600 hover:text-neutral-300 hover:border-neutral-700 transition-all flex items-center justify-center"
                    title="Clear all"
                  >
                    <IconTrash className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Notifications List */}
            <div className="relative">
              <div className="overflow-y-auto max-h-[340px] pb-8">
                {notifications.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                    <div className="w-12 h-12 rounded-xl bg-neutral-900 border border-neutral-800/60 flex items-center justify-center mb-3">
                      <IconBell className="h-5 w-5 text-neutral-600" />
                    </div>
                    <p className="text-neutral-400 text-sm font-light">No notifications</p>
                    <p className="text-neutral-600 text-xs mt-1">
                      Updates appear here when data is analyzed
                    </p>
                  </div>
                ) : (
                  <div className="py-1">
                    {notifications.slice(0, 8).map((notification, index) => (
                      <motion.div
                        key={notification.id}
                        initial={{ opacity: 0, filter: 'blur(4px)' }}
                        animate={{ opacity: 1, filter: 'blur(0px)' }}
                        transition={{ delay: index * 0.03, duration: 0.2 }}
                      className={cn(
                        "group relative px-4 py-3 cursor-pointer transition-all",
                        "hover:bg-neutral-900/50",
                        !notification.read && "bg-neutral-900/30"
                      )}
                      onClick={() => handleNotificationClick(notification)}
                    >
                      <div className="flex items-start gap-3">
                        {/* Icon */}
                        <div className={cn(
                          "flex-shrink-0 h-8 w-8 rounded-lg border border-neutral-800/60 bg-neutral-900/50",
                          "flex items-center justify-center"
                        )}>
                          {getNotificationIcon(notification.type)}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className={cn(
                              "text-sm font-light truncate",
                              notification.read ? "text-neutral-500" : "text-neutral-200"
                            )}>
                              {notification.title}
                            </p>
                            {!notification.read && (
                              <span className="flex-shrink-0 w-1.5 h-1.5 bg-neutral-500 rounded-full" />
                            )}
                          </div>
                          <p className="text-xs text-neutral-600 mt-0.5 line-clamp-1">
                            {notification.message}
                          </p>
                          <div className="flex items-center justify-between mt-1.5">
                            <p className="text-[10px] text-neutral-700">
                              {formatTimestamp(notification.timestamp)}
                            </p>
                            <p className="text-[10px] text-neutral-600 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                              View <IconArrowRight className="h-2.5 w-2.5" />
                            </p>
                          </div>
                        </div>

                        {/* Delete Button */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            clearNotification(notification.id);
                          }}
                          className={cn(
                            "flex-shrink-0 h-6 w-6 rounded-md opacity-0 group-hover:opacity-100",
                            "text-neutral-700 hover:text-neutral-400",
                            "transition-all flex items-center justify-center"
                          )}
                        >
                          <IconX className="h-3 w-3" />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
              </div>
              {notifications.length > 3 && (
                <ProgressiveBlur height="60px" position="bottom" className="pointer-events-none" />
              )}
            </div>

            {/* View All Footer */}
            {onViewAll && notifications.length > 0 && (
              <div className="border-t border-neutral-800/60 p-2">
                <button
                  onClick={() => {
                    onViewAll();
                    setIsOpen(false);
                  }}
                  className={cn(
                    "w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg",
                    "text-xs text-neutral-500 hover:text-neutral-300",
                    "hover:bg-neutral-900/50",
                    "transition-all"
                  )}
                >
                  <span>View all notifications</span>
                  <IconArrowRight className="h-3 w-3" />
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
