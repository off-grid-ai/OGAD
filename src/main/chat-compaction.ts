import { llm } from './llm'

type ConversationMessage = {
  role: string
  content?: unknown
  [key: string]: unknown
}

const SUMMARY_INSTRUCTION =
  'Summarize only the older conversation history below. Preserve decisions, user preferences, names, facts, open questions, and unresolved work. Do not answer the user. Return only the concise summary.'

function messageText(message: ConversationMessage): string {
  if (typeof message.content === 'string') return message.content
  return JSON.stringify(message.content ?? '')
}

/** Summarize old history while preserving the complete active turn byte-for-byte. */
export async function compactDesktopMessages(
  messages: readonly ConversationMessage[]
): Promise<{ messages: ConversationMessage[]; before: number; after: number } | null> {
  const system = messages.filter((message) => message.role === 'system')
  const nonSystem = messages.filter((message) => message.role !== 'system')
  const activeNonSystemStart = nonSystem.map((message) => message.role).lastIndexOf('user')
  if (activeNonSystemStart < 0) return null
  const older = nonSystem.slice(0, activeNonSystemStart)
  const activeTurn = nonSystem.slice(activeNonSystemStart)
  if (older.length < 3) return null

  const recentHistory = older.slice(-2)
  const historyToSummarize = older.slice(0, -2)
  const transcript = historyToSummarize
    .map((message) => `${message.role}: ${messageText(message).slice(0, 2_000)}`)
    .join('\n\n')
  const summary = (
    await llm.chatMessages(
      [
        { role: 'system', content: SUMMARY_INSTRUCTION },
        { role: 'user', content: transcript }
      ],
      undefined,
      512,
      { disableThinking: true }
    )
  ).trim()
  if (!summary) return null

  const compacted: ConversationMessage[] = [
    ...system,
    {
      role: 'assistant',
      content: `[Previous conversation summary]\n${summary}`
    },
    ...recentHistory,
    ...activeTurn
  ]
  const before = nonSystem.length
  const after = compacted.filter((message) => message.role !== 'system').length
  return after < before ? { messages: compacted, before, after } : null
}
