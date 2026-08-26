import { guidanceTaskForJourney, type TaskSession } from './task-session-store'

const CHAT_VIEWS = new Set(['memory-chat', 'chats'])

export interface ChatLeaveGuardState {
  currentView: string
  nextView: string
  conversationId: string | null
  tasks: readonly Pick<TaskSession, 'journeyId' | 'status' | 'updatedAt' | 'kind'>[]
}

/** One policy for every route out of Chat. Task-panel interactions do not change
 * the route, so they never reach this boundary. */
export function shouldConfirmChatLeave({
  currentView,
  nextView,
  conversationId,
  tasks
}: ChatLeaveGuardState): boolean {
  if (!CHAT_VIEWS.has(currentView) || CHAT_VIEWS.has(nextView)) return false
  const activeTask = guidanceTaskForJourney(tasks, conversationId)
  return activeTask?.kind === 'web_use' || activeTask?.kind === 'computer_use'
}
