import { motion, AnimatePresence } from 'motion/react';
import { IconBell, IconX, IconShieldCheck, IconChecklist, IconCheck, IconTrash, IconFilter } from '@tabler/icons-react';
import { useNotifications, Notification } from '../hooks/useNotifications';
import { cn } from '../lib/utils';
import { useState } from 'react';
import { ProgressiveBlur } from './ui/progressive-blur';

interface NotificationListProps {
  /** Open the Actions / Approvals screen (where approvals and to-dos live). */
  onOpenActions?: () => void;
}

type FilterType = 'all' | 'approval' | 'todo';

function getNotificationIcon(type: Notification['type']) {
  const iconClass = "h-5 w-5 text-neutral-500";
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
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  
  return date.toLocaleDateString(undefined, { 
    month: 'short', 
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
}

function getTypeLabel(type: FilterType): string {
  switch (type) {
    case 'all': return 'All';
    case 'approval': return 'Approvals';
    case 'todo': return 'To-do';
    default: return 'All';
  }
}

export function NotificationList({ onOpenActions }: NotificationListProps) {
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearNotification, clearAll } = useNotifications();
  const [filter, setFilter] = useState<FilterType>('all');

  const filteredNotifications = filter === 'all'
    ? notifications
    : notifications.filter(n => n.type === filter);

  const handleNotificationClick = (notification: Notification) => {
    markAsRead(notification.id);
    // Both approvals and to-dos live on the Actions screen.
    onOpenActions?.();
  };

  const filterOptions: FilterType[] = ['all', 'approval', 'todo'];

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <motion.div 
        initial={{ opacity: 0, filter: 'blur(10px)' }}
        animate={{ opacity: 1, filter: 'blur(0px)' }}
        transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
        className="flex items-center justify-between mb-6"
      >
        <div>
          <h1 className="text-2xl font-light text-white tracking-tight">Notifications</h1>
          <p className="text-neutral-500 text-sm mt-1">
            {unreadCount > 0 ? `${unreadCount} unread notification${unreadCount > 1 ? 's' : ''}` : 'All caught up!'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button
              onClick={markAllAsRead}
              className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-neutral-500 hover:text-neutral-200 border border-neutral-800/60 hover:border-neutral-700 bg-neutral-900/50 transition-all"
            >
              <IconCheck className="h-4 w-4" />
              Mark all read
            </button>
          )}
          {notifications.length > 0 && (
            <button
              onClick={clearAll}
              className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-neutral-500 hover:text-red-400 hover:border-red-500/40 border border-neutral-800/60 bg-neutral-900/50 transition-all"
            >
              <IconTrash className="h-4 w-4" />
              Clear all
            </button>
          )}
        </div>
      </motion.div>

      {/* Filter Tabs */}
      <motion.div 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1, ease: [0.25, 0.46, 0.45, 0.94] }}
        className="flex items-center gap-2 mb-6 pb-4 border-b border-neutral-800/60"
      >
        <IconFilter className="h-4 w-4 text-neutral-600 mr-2" />
        {filterOptions.map((type) => {
          const count = type === 'all' 
            ? notifications.length 
            : notifications.filter(n => n.type === type).length;
          const isActive = filter === type;
          
          return (
            <button
              key={type}
              onClick={() => setFilter(type)}
              className={cn(
                "relative px-3 py-1.5 rounded-full text-sm font-medium transition-all",
                isActive
                  ? "text-white"
                  : "text-neutral-500 hover:text-neutral-300"
              )}
            >
              {isActive && (
                <motion.div
                  layoutId="activeNotificationFilter"
                  className="absolute inset-0 bg-neutral-800 border border-neutral-700 rounded-full"
                  transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                {getTypeLabel(type)}
                {count > 0 && (
                  <span className={cn(
                    "px-1.5 py-0.5 text-[10px] font-medium rounded-full",
                    isActive ? "bg-neutral-700 text-neutral-300" : "bg-neutral-800/80 text-neutral-500"
                  )}>
                    {count}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </motion.div>

      {/* Notifications List */}
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 overflow-y-auto pb-16">
          <AnimatePresence mode="wait">
            {filteredNotifications.length === 0 ? (
              <motion.div 
                key="empty"
                initial={{ opacity: 0, filter: 'blur(10px)' }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, filter: 'blur(5px)' }}
                transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
                className="h-full flex flex-col items-center justify-center text-center px-4"
              >
                <div className="w-16 h-16 rounded-2xl bg-neutral-800 border border-neutral-700 flex items-center justify-center mb-4">
                  <IconBell className="w-8 h-8 text-neutral-600" />
                </div>
                <p className="text-neutral-400 text-lg font-light mb-2">
                  {filter === 'all' ? 'No notifications yet' : `No ${getTypeLabel(filter).toLowerCase()} notifications`}
                </p>
                <p className="text-neutral-600 text-sm max-w-md">
                  {filter === 'all'
                    ? "Updates appear here when Off Grid queues an approval for you or extracts a new to-do from your activity."
                    : `${getTypeLabel(filter)} notifications will appear here when they occur.`}
                </p>
              </motion.div>
            ) : (
              <motion.div 
                key="list"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-2 px-1"
              >
                {filteredNotifications.map((notification, index) => (
                  <motion.div
                    key={notification.id}
                    initial={{ opacity: 0, y: 20, filter: 'blur(4px)' }}
                    animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.3, delay: index * 0.05, ease: [0.25, 0.46, 0.45, 0.94] }}
                    whileHover={{ scale: 1.01 }}
                    className={cn(
                      "group relative p-4 rounded-xl cursor-pointer transition-all",
                      "border border-neutral-800/60 hover:border-neutral-700",
                      "bg-neutral-900/60 hover:bg-neutral-800/50",
                      !notification.read && "bg-neutral-900/80 border-neutral-700"
                    )}
                    onClick={() => handleNotificationClick(notification)}
                  >
                    <div className="flex items-start gap-4">
                      {/* Icon */}
                      <div className={cn(
                        "flex-shrink-0 h-10 w-10 rounded-xl border border-neutral-800/60",
                        "bg-neutral-900/50 flex items-center justify-center"
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
                          <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-neutral-800 text-neutral-400 border border-neutral-700">
                            {notification.type}
                          </span>
                        </div>
                        <p className="text-xs text-neutral-600 mt-1 line-clamp-2">
                          {notification.message}
                        </p>
                        <div className="flex items-center justify-between mt-2">
                          <p className="text-[10px] text-neutral-700">
                            {formatTimestamp(notification.timestamp)}
                          </p>
                          <p className="text-[10px] text-neutral-600 opacity-0 group-hover:opacity-100 transition-opacity">
                            Click to view →
                          </p>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex-shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {!notification.read && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              markAsRead(notification.id);
                            }}
                            className="h-7 w-7 rounded-lg text-neutral-600 hover:text-neutral-300 border border-neutral-800/60 hover:border-neutral-700 bg-neutral-900/50 transition-all flex items-center justify-center"
                            title="Mark as read"
                          >
                            <IconCheck className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            clearNotification(notification.id);
                          }}
                          className="h-7 w-7 rounded-lg text-neutral-600 hover:text-red-400 hover:border-red-500/40 border border-neutral-800/60 bg-neutral-900/50 transition-all flex items-center justify-center"
                          title="Delete"
                        >
                          <IconX className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <ProgressiveBlur height="80px" position="bottom" className="pointer-events-none" />
      </div>
    </div>
  );
}
