import {
  ContextCompactionService,
  type ChatCompactionContext,
  type CompactableGenerationMessage,
  type GenerationMessage
} from '@offgrid/models'
import type { DesktopChatSessionBoundary } from './desktop-chat-session-contract'

const DEFAULT_CONTEXT_LENGTH = 4096

/**
 * Desktop ports for the shared context compaction. Shared owns the plan, the summary, and the
 * keep-and-continue rule; this only reaches llama-server's window and its generation over IPC.
 * The summary lives for the renderer's lifetime: after a reload the next compaction summarizes
 * the full history again, which is correct, only slower.
 */
export class DesktopChatCompaction {
  private contextLength = DEFAULT_CONTEXT_LENGTH
  private readonly summaries = new Map<string, string>()
  private readonly service: ContextCompactionService<CompactableGenerationMessage>

  constructor(private readonly boundary: DesktopChatSessionBoundary) {
    this.service = new ContextCompactionService<CompactableGenerationMessage>({
      clearContext: async () => undefined,
      contextLength: () => this.contextLength,
      // No tokenizer crosses the Desktop IPC; the shared character estimate is the budget.
      countTokens: async (text) => Math.ceil(text.length / 4),
      summarize: (messages, maxTokens) => {
        if (!boundary.generateText) throw new Error('Desktop plain generation is unavailable')
        return boundary.generateText(messages, { maxTokens })
      },
      persist: (conversationId, summary) => {
        if (summary) this.summaries.set(conversationId, summary)
        else this.summaries.delete(conversationId)
      },
      systemMessage: (content) => ({ id: 'system', role: 'system', content }),
      summaryMessage: (content) => ({
        id: 'compaction-summary',
        role: 'assistant',
        content: `[Previous conversation summary]\n${content}`
      })
    })
  }

  isCapacityError(error: unknown): boolean {
    return this.service.isCapacityError(error)
  }

  /** Null when Desktop lacks the ports; the shared session then surfaces the original error. */
  async compact(context: ChatCompactionContext): Promise<readonly GenerationMessage[] | null> {
    if (!this.boundary.generateText || !this.boundary.getLlmSettings) return null
    const settings = await this.boundary.getLlmSettings().catch(() => null)
    this.contextLength = settings?.effectiveCtxSize || settings?.ctxSize || DEFAULT_CONTEXT_LENGTH
    return this.service.compactChat(context, {
      previousSummary: this.summaries.get(context.identity.conversationId)
    })
  }
}
