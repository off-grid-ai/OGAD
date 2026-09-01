import {
  ChatSessionService,
  type ChatQueueProjection,
  type ChatSessionEvent,
  type ChatSessionRepositoryPort,
  type ChatTurn,
  type GenerationEvents,
  type GenerationResult,
  type RuntimeModel
} from '@offgrid/models'
import type { RagChatResultContract } from '../../../shared/ipc-contracts'
import { subscribeDesktopChatStream } from './desktop-chat-stream-hub'
import type {
  DesktopChatSessionBoundary,
  DesktopChatSessionInput,
  DesktopChatSessionResult,
  DesktopImageChatSessionInput,
  DesktopImageChatSessionResult,
  DesktopImageGenerationResponse,
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

const DESKTOP_CHAT_ROUTE: RuntimeModel = {
  id: 'active-text',
  name: 'Active text model',
  kind: 'text',
  modality: 'text',
  source: 'local',
  adapterId: 'desktop-chat-ipc',
  capabilities: {},
  installed: true,
  ready: true,
  loaded: true
}

class DesktopTurnRepository implements ChatSessionRepositoryPort {
  private readonly conversations = new Map<string, ChatTurn[]>()

  async read(conversationId: string): Promise<readonly ChatTurn[]> {
    return this.conversations.get(conversationId) ?? []
  }

  async write(conversationId: string, turns: readonly ChatTurn[]): Promise<void> {
    this.conversations.set(conversationId, [...turns])
  }

  invalidate(conversationId: string): void {
    this.conversations.delete(conversationId)
  }
}

/**
 * Desktop composition adapter for the shared chat lifecycle.
 *
 * The shared service owns queueing, cancellation, partial-output rules, and turn state. Electron
 * remains a transport boundary: the legacy `rag:chat` IPC handler still projects Desktop RAG and
 * the real main-process GenerationService until that handler becomes a first-class generation port.
 */
export class DesktopChatSession {
  private readonly repository = new DesktopTurnRepository()
  private readonly executions = new Map<string, TurnExecution>()
  private readonly listeners = new Set<(event: ChatSessionEvent) => void>()
  private readonly service: ChatSessionService

  constructor(private readonly boundary: DesktopChatSessionBoundary) {
    this.service = new ChatSessionService(
      {
        generate: (request, events) =>
          this.generate(request.identity?.turnId, request.signal, events)
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

  async send(input: DesktopChatSessionInput): Promise<DesktopChatSessionResult> {
    this.executions.set(input.turnId, { input, route: 'rag' })
    try {
      const turn = await this.service.send({
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
      const turn = await this.service.send({
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
      const turn = await this.service.send({
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

  private async generate(
    turnId: string | undefined,
    signal: AbortSignal | undefined,
    events?: GenerationEvents
  ): Promise<GenerationResult> {
    if (!turnId) throw new Error('Desktop chat generation requires a turn identity')
    const execution = this.executions.get(turnId)
    if (!execution) throw new Error(`Desktop chat execution is missing for turn ${turnId}`)
    const { input } = execution
    const unsubscribe = subscribeDesktopChatStream(this.boundary, (event) => {
      if (event.streamId !== input.turnId) return
      if (event.type === 'content' && event.text) events?.chunk?.({ content: event.text })
      if (event.type === 'reasoning' && event.text) events?.chunk?.({ reasoning: event.text })
    })
    try {
      if (execution.route === 'image') return this.generateImage(execution, signal)
      if (execution.route === 'tools') return this.generateTools(execution, signal, events)
      return this.generateRag(execution, signal)
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
    return {
      model: {
        ...DESKTOP_CHAT_ROUTE,
        id: response.model ?? 'active-image',
        kind: 'image',
        modality: 'image'
      },
      output: {
        type: 'image',
        images: [
          {
            id: response.syncId,
            uri: response.path,
            mimeType: 'image/png',
            seed: response.seed
          }
        ]
      },
      content: '',
      reasoning: '',
      toolCalls: [],
      finishReason: signal?.aborted ? 'cancelled' : 'stop',
      attemptedModelIds: [response.model ?? 'active-image'],
      attemptedRouteIds: []
    }
  }

  private async generateTools(
    execution: TurnExecution,
    signal: AbortSignal | undefined,
    events?: GenerationEvents
  ): Promise<GenerationResult> {
    if (!this.boundary.toolChat) throw new Error('Desktop tool-chat boundary is unavailable')
    const input = execution.input as DesktopToolChatSessionInput
    const response = await this.boundary.toolChat(input.query, input.history, {
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
    return this.textResult(response.answer ?? '', signal)
  }

  private async generateRag(
    execution: TurnExecution,
    signal: AbortSignal | undefined
  ): Promise<GenerationResult> {
    const { input } = execution
    const response = await this.boundary.ragChat(
      input.query,
      'All',
      input.history,
      input.projectId,
      input.conversationId,
      input.noMemory && !input.projectId,
      input.turnId,
      input.thinking,
      input.images
    )
    execution.response = response
    return this.textResult(response.answer, signal)
  }

  private textResult(content: string, signal: AbortSignal | undefined): GenerationResult {
    return {
      model: DESKTOP_CHAT_ROUTE,
      output: { type: 'text', content },
      content,
      reasoning: '',
      toolCalls: [],
      finishReason: signal?.aborted ? 'cancelled' : 'stop',
      attemptedModelIds: [DESKTOP_CHAT_ROUTE.id],
      attemptedRouteIds: []
    }
  }

  private publish(event: ChatSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

export function createDesktopChatSession(
  boundary: DesktopChatSessionBoundary = window.api
): DesktopChatSession {
  return new DesktopChatSession(boundary)
}
