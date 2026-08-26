import { describe, expect, it } from 'vitest'
import { shouldConfirmChatLeave } from '../chat-leave-guard'
import type { TaskSession } from '../task-session-store'

function task(status: TaskSession['status'], journeyId = 'chat-1'): TaskSession {
  return {
    taskId: 'task-1',
    journeyId,
    kind: 'web_use',
    title: 'Research',
    status,
    steps: [],
    startedAt: 1,
    updatedAt: 2
  }
}

describe('chat leave guard', () => {
  it.each(['running', 'paused', 'waiting', 'reconnecting'] as const)(
    'warns before a route leaves Chat for a %s task in this conversation',
    (status) => {
      expect(
        shouldConfirmChatLeave({
          currentView: 'memory-chat',
          nextView: 'projects',
          conversationId: 'chat-1',
          tasks: [task(status)]
        })
      ).toBe(true)
    }
  )

  it.each(['done', 'failed', 'stopped'] as const)('does not warn for a %s task', (status) => {
    expect(
      shouldConfirmChatLeave({
        currentView: 'memory-chat',
        nextView: 'projects',
        conversationId: 'chat-1',
        tasks: [task(status)]
      })
    ).toBe(false)
  })

  it('does not warn for another chat, a change inside Chat, or a task-panel interaction', () => {
    const tasks = [task('running', 'another-chat')]
    expect(
      shouldConfirmChatLeave({
        currentView: 'memory-chat',
        nextView: 'projects',
        conversationId: 'chat-1',
        tasks
      })
    ).toBe(false)
    expect(
      shouldConfirmChatLeave({
        currentView: 'memory-chat',
        nextView: 'chats',
        conversationId: 'chat-1',
        tasks: [task('running')]
      })
    ).toBe(false)
    expect(
      shouldConfirmChatLeave({
        currentView: 'memory-chat',
        nextView: 'memory-chat',
        conversationId: 'chat-1',
        tasks: [task('running')]
      })
    ).toBe(false)
  })
})
