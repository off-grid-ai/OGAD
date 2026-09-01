import {
  ChatSessionService,
  type ChatQueueProjection,
  type ChatSessionEvent,
  type ChatTurn,
  type GenerationEvents,
  type GenerationMessage,
  type GenerationResult
} from '@offgrid/models'
import type { RagChatResultContract } from '../../../shared/ipc-contracts'
import { subscribeDesktopChatStream } from './desktop-chat-stream-hub'
import { DesktopTurnRepository } from './desktop-chat-session-repository'
import { publishDesktopChatEvent } from './desktop-chat-session-events'
import {
  desktopHistory,
  desktopImageResult,
  desktopTextResult
} from './desktop-chat-session-policy'
import type {
  DesktopChatSessionBoundary,
  DesktopChatSessionInput,
  DesktopChatSessionResult,
  DesktopImageChatSessionInput,
  DesktopImageChatSessionResult,
  DesktopImageGenerationResponse,
  DesktopQueuedTurnProjection,
  DesktopToolChatResponse,
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

interface TurnExecution {
  input: DesktopChatSessionInput
  route: 'rag' | 'tools' | 'image'
  response?: RagChatResultContract
  toolResponse?: DesktopToolChatResponse
  imageResponse?: DesktopImageGenerationResponse
}

export class DesktopChatSession {
  private readonly repository = new DesktopTurnRepository()
  private readonly executions = new Map<string, TurnExecution>()
  private readonly listeners = new Set<(event: ChatSessionEvent) => void>()
  private readonly service: ChatSessionService

  constructor(private readonly boundary: DesktopChatSessionBoundary) {
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

  async send(input: DesktopChatSessionInput): Promise<DesktopChatSessionResult> {
    this.executions.set(input.turnId, { input, route: 'rag' })
    try {
      const turn = await this.run(input, {
        conversationId: input.conversationId,
        turnId: input.turnId,
        projectId: input.projectId ?? undefined,
        userMessage: input.userMessage,
        operation: input.images.length ? { type: 'vision' } : { type: 'text' },
        allowFallback: true,
        partialOutputPolicy: 'preserve-and-stop'
      })
      const response = this.executions.get(input.turnId)?.response
      if (!response && turn.status === 'stopped') return { turn, response: { answer: '' } }
      if (!response) throw new Error(`Desktop chat response is missing for turn ${input.turnId}`)
      return { turn, response }
    } finally {
      this.executions.delete(input.turnId)
    }
  }

  async sendWithTools(input: DesktopToolChatSessionInput): Promise<DesktopToolChatSessionResult> {
    this.executions.set(input.turnId, { input, route: 'tools' })
    try {
      const turn = await this.run(input, {
        conversationId: input.conversationId,
        turnId: input.turnId,
        projectId: input.projectId ?? undefined,
        userMessage: input.userMessage,
        operation: input.images.length ? { type: 'vision' } : { type: 'text' },
        allowFallback: true,
        partialOutputPolicy: 'preserve-and-stop'
      })
      const response = this.executions.get(input.turnId)?.toolResponse
      if (!response && turn.status === 'stopped') return { turn, response: {} }
      if (!response) throw new Error(`Desktop tool response is missing for turn ${input.turnId}`)
      return { turn, response }
    } finally {
      this.executions.delete(input.turnId)
    }
  }

  async sendImage(input: DesktopImageChatSessionInput): Promise<DesktopImageChatSessionResult> {
    this.executions.set(input.turnId, { input, route: 'image' })
    try {
      const turn = await this.run(input, {
        conversationId: input.conversationId,
        turnId: input.turnId,
        projectId: input.projectId ?? undefined,
        userMessage: input.userMessage,
        operation: {
          type: 'image',
          prompt: input.request.prompt,
          negativePrompt: input.request.negativePrompt,
          width: input.request.width,
          height: input.request.height,
          steps: input.request.steps,
          guidanceScale: input.request.cfgScale,
          seed: input.request.seed,
          strength: input.request.strength
        },
        allowFallback: false,
        partialOutputPolicy: 'preserve-and-stop'
      })
      const response = this.executions.get(input.turnId)?.imageResponse
      if (!response && turn.status === 'stopped') {
        throw new Error('Desktop image generation cancelled')
      }
      if (!response) throw new Error(`Desktop image response is missing for turn ${input.turnId}`)
      return { turn, response }
    } finally {
      this.executions.delete(input.turnId)
    }
  }

  stopConversation(conversationId: string, reason?: unknown): number {
    const pending = [...this.executions.values()].filter(
      (execution) => execution.input.conversationId === conversationId
    )
    if (pending.some((execution) => execution.route === 'image')) {
      this.boundary.cancelImageGen?.()
    }
    for (const execution of pending) {
      if (execution.route !== 'image') this.boundary.cancelRag(execution.input.turnId)
    }
    return this.service.stopConversation(conversationId, reason)
  }

  invalidate(conversationId: string): void {
    this.service.stopConversation(conversationId)
    this.repository.invalidate(conversationId)
  }

  private run(
    input: DesktopChatSessionInput,
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
    context: {
      messages: readonly GenerationMessage[]
      signal: AbortSignal | undefined
      events?: GenerationEvents
    }
  ): Promise<GenerationResult> {
    if (!turnId) throw new Error('Desktop chat generation requires a turn identity')
    const execution = this.executions.get(turnId)
    if (!execution) throw new Error(`Desktop chat execution is missing for turn ${turnId}`)
    const { input } = execution
    const { messages, signal, events } = context
    const unsubscribe = subscribeDesktopChatStream(this.boundary, (event) => {
      if (event.streamId !== input.turnId) return
      if (event.type === 'content' && event.text) events?.chunk?.({ content: event.text })
      if (event.type === 'reasoning' && event.text) events?.chunk?.({ reasoning: event.text })
    })
    try {
      if (execution.route === 'image') return this.generateImage(execution, signal)
      if (execution.route === 'tools') {
        return this.generateTools(execution, context)
      }
      return this.generateRag(execution, messages, signal)
    } finally {
      unsubscribe()
    }
  }

  private async generateImage(
    execution: TurnExecution,
    signal: AbortSignal | undefined
  ): Promise<GenerationResult> {
    if (!this.boundary.generateImage) {
      throw new Error('Desktop image-generation boundary is unavailable')
    }
    const imageInput = execution.input as DesktopImageChatSessionInput
    const response = await this.boundary.generateImage(imageInput.request)
    execution.imageResponse = response
    return desktopImageResult(response, signal)
  }

  private async generateTools(
    execution: TurnExecution,
    context: {
      messages: readonly GenerationMessage[]
      signal: AbortSignal | undefined
      events?: GenerationEvents
    }
  ): Promise<GenerationResult> {
    if (!this.boundary.toolChat) throw new Error('Desktop tool-chat boundary is unavailable')
    const input = execution.input as DesktopToolChatSessionInput
    const { messages, signal, events } = context
    const response = await this.boundary.toolChat(input.query, desktopHistory(messages), {
      connectors: input.connectors,
      conversationId: input.conversationId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      allMemory: input.allMemory,
      images: input.images,
      imageAvailable: input.imageAvailable,
      streamId: input.turnId,
      thinking: input.thinking
    })
    execution.toolResponse = response
    const calls = response.toolCalls ?? []
    if (calls.length) {
      events?.message?.({
        role: 'assistant',
        content: '',
        toolCalls: calls.map((call, index) => ({
          id: `${input.turnId}:tool:${index}`,
          name: call.name,
          arguments: '{}'
        }))
      })
      calls.forEach((call, index) => {
        events?.message?.({
          role: 'tool',
          content: call.result,
          name: call.name,
          toolCallId: `${input.turnId}:tool:${index}`
        })
      })
    }
    return desktopTextResult(response.answer ?? '', signal)
  }

  private async generateRag(
    execution: TurnExecution,
    messages: readonly GenerationMessage[],
    signal: AbortSignal | undefined
  ): Promise<GenerationResult> {
    const { input } = execution
    const response = await this.boundary.ragChat(
      input.query,
      'All',
      desktopHistory(messages),
      input.projectId,
      input.conversationId,
      input.noMemory && !input.projectId,
      input.turnId,
      input.thinking,
      input.images
    )
    execution.response = response
    return desktopTextResult(response.answer, signal)
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
