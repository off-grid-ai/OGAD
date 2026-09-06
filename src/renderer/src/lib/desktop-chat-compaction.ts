import {
  type ContextCompactionService,
  type ChatCompactionContext,
  type CompactableGenerationMessage,
  type GenerationMessage
} from '@offgrid/application'
import type { DesktopChatSessionBoundary } from './desktop-chat-session-contract'
import { chatContextCompactionService } from '@renderer/composition/chat-session'
import {
  executeWorkspaceContentCommand,
  getWorkspaceContentSnapshot
} from './workspace-content-client'

const DEFAULT_CONTEXT_LENGTH = 4096

/**
 * Desktop ports for the shared context compaction. Shared owns the plan, the summary, and the
 * keep-and-continue rule; this only reaches llama-server's window and its generation over IPC.
 * Durable summary state belongs to the canonical Workspace Content conversation. This adapter
 * reads that projection and sends one awaited command; it keeps no renderer-owned summary copy.
 */
export class DesktopChatCompaction {
  private contextLength = DEFAULT_CONTEXT_LENGTH
  private readonly service: ContextCompactionService<CompactableGenerationMessage>

  constructor(private readonly boundary: DesktopChatSessionBoundary) {
    this.service = chatContextCompactionService({
      clearContext: async () => undefined,
      contextLength: () => this.contextLength,
      // No tokenizer crosses the Desktop IPC; the shared character estimate is the budget.
      countTokens: async (text) => Math.ceil(text.length / 4),
      summarize: (messages, maxTokens) => {
        if (!boundary.generateText) throw new Error('Desktop plain generation is unavailable')
        return boundary.generateText(messages, { maxTokens })
      },
      persist: async (conversationId, summary, cutoffMessageId) => {
        const outcome = await executeWorkspaceContentCommand({
          type: 'update_conversation',
          conversationId,
          patch: {
            compactionSummary: summary ?? null,
            compactionCutoffMessageId: cutoffMessageId ?? null
          }
        })
        if (!outcome.ok) {
          throw new Error(`Compaction state was not saved: ${outcome.failure.message}`)
        }
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
    const [settings, workspaceContent] = await Promise.all([
      this.boundary.getLlmSettings().catch(() => null),
      getWorkspaceContentSnapshot().catch(() => null)
    ])
    if (workspaceContent?.status !== 'ready') return null
    const conversation = workspaceContent.conversations.find(
      ({ id }) => id === context.identity.conversationId
    )
    if (!conversation) return null
    this.contextLength = settings?.effectiveCtxSize || settings?.ctxSize || DEFAULT_CONTEXT_LENGTH
    return this.service.compactChat(context, {
      ...(conversation.compactionSummary !== undefined
        ? { previousSummary: conversation.compactionSummary }
        : {}),
      ...(conversation.compactionCutoffMessageId !== undefined
        ? { previousCutoffMessageId: conversation.compactionCutoffMessageId }
        : {})
    })
  }
}
