import {
  ChatSessionService,
  type ChatQueueProjection,
  type ChatSessionEvent,
  type ChatTurn,
  type GenerationResult
} from '@offgrid/models'
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
  private readonly repository = new DesktopTurnRepository()
  private readonly executions = new Map<string, DesktopTurnExecution>()
  private readonly listeners = new Set<(event: ChatSessionEvent) => void>()
  private readonly service: ChatSessionService
  private readonly generation: DesktopChatGenerationAdapter

  constructor(private readonly boundary: DesktopChatSessionBoundary) {
    this.generation = new DesktopChatGenerationAdapter(boundary)
    this.service = new ChatSessionService(
      {
        generate: (request, events) =>
          this.generate(request.identity?.turnId, {
            messages: request.messages ?? [],
            signal: request.signal,
            events
          })
      },
      this.repository,
      { events: { publish: (event) => this.publish(event) } }
    )
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

  restoreConversation(conversationId: string, turns: readonly ChatTurn[]): void {
    if (
      this.service
        .queueProjection()
        .entries.some((entry) => entry.conversationId === conversationId)
    ) {
      return
    }
    this.repository.restore(conversationId, turns)
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
      allowFallback: input.kind !== 'image',
      partialOutputPolicy: 'preserve-and-stop'
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
    return { turn, response, generatedImages }
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
