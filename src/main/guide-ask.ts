import { ipcMain } from 'electron'
import type { ChatMessage } from './llm/chat-payload'
import { CHAT_JOB, modalityQueue } from './modality-queue/queue'

type GuideTurn = { role: 'system' | 'user' | 'assistant'; content: string }

function isTurn(value: unknown): value is GuideTurn {
  if (!value || typeof value !== 'object') return false
  const turn = value as Record<string, unknown>
  return (
    (turn.role === 'system' || turn.role === 'user' || turn.role === 'assistant') &&
    typeof turn.content === 'string'
  )
}

/** The guide's answer, or why there is none: no chat model to ask, or the ask failed. */
export type GuideAnswer = { answer: string } | { error: 'no-model' | 'failed' }

/**
 * The Ask box on "What it does for you": the renderer sends the grounding and the
 * conversation, the chat model the person chose answers. Someone is waiting on it, so it runs
 * as chat.
 */
export function setupGuideAskIpc(): void {
  ipcMain.handle('guide:ask', async (_event, turns: unknown): Promise<GuideAnswer> => {
    if (!Array.isArray(turns) || turns.length === 0 || !turns.every(isTurn)) {
      return { error: 'failed' }
    }
    const { llm } = await import('./llm')
    if (!llm.hasTextModel()) return { error: 'no-model' }
    try {
      return await modalityQueue.run(CHAT_JOB, async () => {
        const text = await llm.chatMessages(turns as ChatMessage[], undefined, 700, {
          temperature: 0.2,
          disableThinking: true
        })
        return text.trim() ? { answer: text.trim() } : { error: 'failed' as const }
      })
    } catch {
      return { error: 'failed' }
    }
  })
}
