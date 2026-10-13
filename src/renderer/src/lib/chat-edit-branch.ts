import type { ChatMessage, RagContext } from '../components/MemoryChat/types'
import { priorAnswerVersions } from './chat-versions'

export function editedBranch(
  messages: ChatMessage[],
  index: number,
  content: string
): {
  context: RagContext & { branches: NonNullable<RagContext['branches']> }
  retainedCount: number
  history: ChatMessage[]
} {
  const user = messages[index]!
  const answer = messages
    .slice(index + 1)
    .find((message) => message.role === 'assistant' && !message.notice)
  const context = {
    ...user.context,
    branches: [
      ...(user.context?.branches ?? []),
      { question: user.content, answers: priorAnswerVersions(answer) ?? [] }
    ]
  } satisfies RagContext
  return {
    context,
    retainedCount: index + 1,
    history: messages
      .slice(0, index + 1)
      .map((message) => (message.id === user.id ? { ...message, content, context } : message))
  }
}
