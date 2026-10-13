import { ipcMain } from 'electron'
import { cleanSuggestion, suggestionMessages } from '../shared/chat-next-action'
import { backgroundJob, modalityQueue } from './modality-queue/queue'

/** Optional follow-up work never delays saving or displaying the completed reply. */
export function setupChatNextActionIpc(): void {
  ipcMain.handle('chat:suggest-next', async (_event, asked: unknown, answer: unknown) => {
    if (
      typeof asked !== 'string' ||
      typeof answer !== 'string' ||
      !asked.trim() ||
      !answer.trim()
    ) {
      return null
    }
    const signal = AbortSignal.timeout(15_000)
    try {
      return await modalityQueue.run(backgroundJob('chat suggestion'), async () => {
        signal.throwIfAborted()
        const { llm } = await import('./llm')
        const text = await llm.chatMessages(
          suggestionMessages({ asked, answer, surface: 'desktop' }),
          15_000,
          40,
          { temperature: 0.3, disableThinking: true, signal }
        )
        return cleanSuggestion(text)
      })
    } catch {
      return null
    }
  })
}
