import {
  type ChatSessionService,
  type ChatQueueProjection,
  type ChatSessionEvent,
  type ChatTurn,
  type GenerationResult
} from '@offgrid/application'
import {
  createActiveTurnStore,
  type ActiveTurn,
  type ActiveTurnProjection,
  type ActiveTurnStore
} from './active-turn-store'
import type { StreamEvent } from './stream-reducer'
import { DesktopChatCompaction } from './desktop-chat-compaction'
import { desktopChatTurnProfile } from './desktop-chat-session-policy'
import { chatSessionService } from '@renderer/composition/chat-session'
import { DesktopTurnRepository } from './desktop-chat-session-repository'
import { publishDesktopChatEvent } from './desktop-chat-session-events'
import {
  DesktopChatGenerationAdapter,
  type DesktopGenerationContext,
  type DesktopTurnExecution
} from './desktop-chat-generation-adapter'
import type {
  DesktopChatSessionBoundary,
  DesktopAnyChatSessionInput,
  DesktopChatSessionInput,
  DesktopChatSessionResult,
  DesktopImageChatSessionInput,
  DesktopImageChatSessionResult,
  DesktopQueuedTurnProjection,
  DesktopToolChatSessionInput,
  DesktopToolChatSessionResult
} from './desktop-chat-session-contract'

export { subscribeDesktopChatStream } from './desktop-chat-stream-hub'
export type {
  DesktopChatSessionBoundary,
  DesktopChatSessionInput,
  DesktopChatSessionResult,
  DesktopImageChatSessionInput,
  DesktopImageChatSessionResult,
  DesktopToolChatSessionInput,
  DesktopToolChatSessionResult
} from './desktop-chat-session-contract'

export class DesktopChatSession {
  private readonly repository: DesktopTurnRepository
  /**
   * The live turn's buffer belongs to the session, not to a component: the session is what knows
   * a turn is in flight, and one owner is what makes "at most one visual publication per frame" a
   * property of the product rather than of whichever component happened to create a store.
   */
  private readonly activeTurns: ActiveTurnStore = createActiveTurnStore()
  private readonly executions = new Map<string, DesktopTurnExecution>()
  private readonly listeners = new Set<(event: ChatSessionEvent) => void>()
  private readonly service: ChatSessionService
  private readonly generation: DesktopChatGenerationAdapter
  private readonly compaction: DesktopChatCompaction

  constructor(private readonly boundary: DesktopChatSessionBoundary) {
    this.repository = new DesktopTurnRepository(boundary)
    this.generation = new DesktopChatGenerationAdapter(boundary)
    this.compaction = new DesktopChatCompaction(boundary)
    this.service = chatSessionService(
      {
        generate: (request, events) =>
          this.generate(request.identity?.turnId, {
            messages: request.messages ?? [],
            reasoning: request.reasoning,
            signal: request.signal,
            events
          })
      },
      this.repository,
      {
        events: { publish: (event) => this.publish(event) },
        compactionRetry: { shouldRetry: ({ error }) => this.compaction.isCapacityError(error) },
        compaction: { compact: (context) => this.compaction.compact(context) }
      }
    )
  }

  /** The narrow read side of the live turn, for the view. Stable identity. */
  liveTurns(): ActiveTurnProjection {
    return this.activeTurns.projection()
  }

  /** Open a live turn. `seed` carries a stream that was already running when the view mounted. */
  beginLiveTurn(streamId: string, seed?: Partial<ActiveTurn>): void {
    this.activeTurns.begin(streamId, seed)
  }

  /** Fold one stream event into the live turn. Nothing above the streaming leaf re-renders. */
  applyLiveTurnEvent(streamId: string, event: StreamEvent): void {
    this.activeTurns.apply(streamId, event)
  }

  /**
   * Close the live turn and hand back what only the stream saw.
   *
   * The final CONTENT is not read from here - the send path already has the authoritative answer
   * from the generation result. This is for the tool calls and the activity the stream accumulated.
   */
  finishLiveTurn(streamId: string): ActiveTurn | null {
    return this.activeTurns.finish(streamId)
  }

  /** Drop the live turn: stopped, failed, or its content replaced by something else. */
  cancelLiveTurn(streamId: string): void {
    this.activeTurns.cancel(streamId)
  }

  /** Drop every live turn and any scheduled publication. */
  disposeLiveTurns(): void {
    this.activeTurns.dispose()
  }

  subscribe(listener: (event: ChatSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  queueProjection(): ChatQueueProjection {
    return this.service.queueProjection()
  }

  queuedTurns(conversationId: string): DesktopQueuedTurnProjection[] {
    return this.service
      .queueProjection()
      .entries.filter(
        (entry) => entry.conversationId === conversationId && entry.status === 'queued'
      )
      .flatMap((entry) => {
        const execution = this.executions.get(entry.turnId)
        if (!execution) return []
        return [
          {
            turnId: entry.turnId,
            text: execution.input.query,
            attachmentCount: execution.input.images.length
          }
        ]
      })
  }

  restoreConversation(
    conversationId: string,
    legacyTurns: readonly ChatTurn[] = []
  ): Promise<readonly ChatTurn[]> {
    return this.service.restoreConversation(conversationId, legacyTurns)
  }

  async send(input: DesktopImageChatSessionInput): Promise<DesktopImageChatSessionResult>
  async send(input: DesktopToolChatSessionInput): Promise<DesktopToolChatSessionResult>
  async send(input: DesktopChatSessionInput): Promise<DesktopChatSessionResult>
  async send(
    input: DesktopAnyChatSessionInput
  ): Promise<
    DesktopChatSessionResult | DesktopToolChatSessionResult | DesktopImageChatSessionResult
  > {
    this.executions.set(input.turnId, {
      input,
      generatedImages: [],
      imageActive: false
    })
    try {
      const turn = await this.run(input, this.commandFor(input))
      return this.resultFor(input, turn, this.executions.get(input.turnId))
    } finally {
      this.executions.delete(input.turnId)
    }
  }

  private commandFor(input: DesktopAnyChatSessionInput): Parameters<ChatSessionService['send']>[0] {
    return {
      conversationId: input.conversationId,
      turnId: input.turnId,
      projectId: input.projectId ?? undefined,
      userMessage: input.userMessage,
      operation:
        input.kind === 'image'
          ? {
              type: 'image',
              prompt: input.request.prompt,
              negativePrompt: input.request.negativePrompt,
              width: input.request.width,
              height: input.request.height,
              steps: input.request.steps,
              guidanceScale: input.request.cfgScale,
              seed: input.request.seed,
              strength: input.request.strength
            }
          : input.images.length
            ? { type: 'vision' }
            : { type: 'text' },
      request: {
        profile: desktopChatTurnProfile(input.kind),
        ...(input.kind === 'image' ? {} : { reasoning: { enabled: input.thinking === true } })
      }
    }
  }

  private resultFor(
    input: DesktopAnyChatSessionInput,
    turn: ChatTurn,
    execution: DesktopTurnExecution | undefined
  ): DesktopChatSessionResult | DesktopToolChatSessionResult | DesktopImageChatSessionResult {
    if (input.kind === 'image') return this.imageResult(input, turn, execution)
    if (input.kind === 'tools') return this.toolResult(input, turn, execution)
    return this.chatResult(input, turn, execution)
  }

  private imageResult(
    input: DesktopImageChatSessionInput,
    turn: ChatTurn,
    execution: DesktopTurnExecution | undefined
  ): DesktopImageChatSessionResult {
    const response = execution?.imageResponse
    if (!response && turn.status === 'stopped') {
      throw new Error('Desktop image generation cancelled')
    }
    if (!response) throw new Error(`Desktop image response is missing for turn ${input.turnId}`)
    return { turn, response, generatedImages: execution.generatedImages }
  }

  private toolResult(
    input: DesktopToolChatSessionInput,
    turn: ChatTurn,
    execution: DesktopTurnExecution | undefined
  ): DesktopToolChatSessionResult {
    const response = execution?.toolResponse
    const generatedImages = execution?.generatedImages ?? []
    if (!response && turn.status === 'stopped') return { turn, response: {}, generatedImages }
    if (!response) throw new Error(`Desktop tool response is missing for turn ${input.turnId}`)
    return { turn, response, generatedImages, imageMemoryRetry: execution.imageMemoryRetry }
  }

  private chatResult(
    input: DesktopChatSessionInput,
    turn: ChatTurn,
    execution: DesktopTurnExecution | undefined
  ): DesktopChatSessionResult {
    const response = execution?.response
    const generatedImages = execution?.generatedImages ?? []
    if (!response && turn.status === 'stopped') {
      return { turn, response: { answer: '' }, generatedImages }
    }
    if (!response) throw new Error(`Desktop chat response is missing for turn ${input.turnId}`)
    return { turn, response, generatedImages }
  }

  stopConversation(conversationId: string, reason?: unknown): number {
    const pending = [...this.executions.values()].filter(
      (execution) => execution.input.conversationId === conversationId
    )
    if (pending.some((execution) => execution.imageActive)) {
      this.boundary.cancelImageGen?.()
    }
    for (const execution of pending) {
      if (!execution.imageActive) this.boundary.cancelRag(execution.input.turnId)
    }
    return this.service.stopConversation(conversationId, reason)
  }

  invalidate(conversationId: string): void {
    this.service.stopConversation(conversationId)
    this.repository.invalidate(conversationId)
  }

  private run(
    input: DesktopAnyChatSessionInput,
    command: Parameters<ChatSessionService['send']>[0]
  ): Promise<ChatTurn> {
    if (input.replay === 'regenerate') {
      return this.service.regenerate({ conversationId: input.conversationId, turnId: input.turnId })
    }
    if (input.replay === 'edit') {
      return this.service.edit({
        conversationId: input.conversationId,
        turnId: input.turnId,
        userMessage: input.userMessage
      })
    }
    return this.service.send(command)
  }

  private async generate(
    turnId: string | undefined,
    context: DesktopGenerationContext
  ): Promise<GenerationResult> {
    if (!turnId) throw new Error('Desktop chat generation requires a turn identity')
    const execution = this.executions.get(turnId)
    if (!execution) throw new Error(`Desktop chat execution is missing for turn ${turnId}`)
    return this.generation.generate(execution, context)
  }

  private async publish(event: ChatSessionEvent): Promise<void> {
    await publishDesktopChatEvent({
      event,
      inputFor: (turnId) => this.executions.get(turnId)?.input,
      boundary: this.boundary,
      listeners: this.listeners
    })
  }
}

export function createDesktopChatSession(
  boundary: DesktopChatSessionBoundary = window.api
): DesktopChatSession {
  return new DesktopChatSession(boundary)
}
