import { describe, expect, it } from 'vitest'
import { mapRagMessages } from '../chat-transcript-projection'
import { projectRecoveredChatTurns } from '../chat-restart-projection'
import { readPersistedChatSessionTurn } from '../message-persistence'

describe('chat restart projection', () => {
  it('renders an interrupted Shared turn beside its durable user message with retry identity', () => {
    const raw = [
      {
        uuid: 'user-a',
        role: 'user' as const,
        content: 'Finish this answer.',
        context: { chatTurnId: 'turn-a' },
        created_at: '2026-09-05T02:50:00.000Z'
      }
    ]
    const projected = projectRecoveredChatTurns(raw, mapRagMessages(raw), [
      {
        id: 'turn-a',
        conversationId: 'conversation-a',
        userMessage: { role: 'user', content: 'Finish this answer.' },
        status: 'interrupted',
        errorMessage: 'The app closed before this response finished. Retry the response.',
        request: { operation: { type: 'text' }, request: {} }
      }
    ])

    expect(projected.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Finish this answer.'],
      ['assistant', 'The app closed before this response finished. Retry the response.']
    ])
    expect(readPersistedChatSessionTurn(projected[1]?.context)).toMatchObject({
      turnId: 'turn-a',
      status: 'interrupted'
    })
  })
})
