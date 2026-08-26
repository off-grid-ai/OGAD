import type { TaskSession } from '@renderer/lib/task-session-store'

export type TaskStatus = TaskSession['status']

export type TaskTab = TaskSession & {
  notice?: string
  sessionId?: string
  manual?: boolean
  manualHistoryId?: string
  faviconUrl?: string
}

export function taskTime(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toLocaleString() : '—'
}

export function tabLabel(tab: TaskTab): string {
  if (tab.manual) return 'Browser'
  return tab.kind === 'web_use' ? 'Web Use' : 'Computer Use'
}

export function statusTone(status: TaskStatus): string {
  if (status === 'failed') return 'text-red-500'
  if (status === 'paused') return 'text-amber-500'
  if (status === 'done') return 'text-green-500'
  return 'text-muted-foreground'
}

export function inactiveWebSummary(tab: TaskTab, status: TaskStatus): string {
  if (tab.summary) return tab.summary
  if (status === 'done') return 'This run finished.'
  if (status === 'failed') return 'Web Use could not finish this task.'
  if (status === 'stopped') return 'The browser tab closed before this task finished.'
  return 'Connecting to this browser tab.'
}
