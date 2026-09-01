import {
  ChatSessionService,
  type ChatQueueProjection,
  type ChatSessionEvent,
  type ChatSessionRepositoryPort,
  type ChatTurn,
  type GenerationEvents,
  type GenerationMessage,
  type GenerationResult,
  type RuntimeModel
} from '@offgrid/models'
import type { RagChatResultContract } from '../../../shared/ipc-contracts'
import type { SearchHit } from '../types'

export interface DesktopChatStreamEvent {
  streamId: string
  type: 'content' | 'reasoning' | 'step' | 'tool_result' | 'done'
  text?: string
}

export interface DesktopChatSessionBoundary {
  ragChat(
    query: string,
    appName: string,
    history: { role: string; content: string }[],
    projectId: string | null,
    conversationId: string,
    noMemory: boolean,
    streamId: string,
    thinking: boolean,
    images: string[]
  ): Promise<RagChatResultContract>
  onRagStream(listener: (event: DesktopChatStreamEvent) => void): () => void
  cancelRag(streamId: string): void
  toolChat?(
    query: string,
    history: { role: string; content: string }[],
    options: DesktopToolChatOptions
  ): Promise<DesktopToolChatResponse>
}

export interface DesktopToolChatOptions {
  connectors: boolean
  conversationId: string
  projectId?: string
  allMemory: boolean
  images: string[]
  imageAvailable: boolean
  streamId: string
  thinking: boolean
}

export interface DesktopToolChatResponse {
  answer?: string
  unified?: Array<
    Omit<SearchHit, 'key' | 'refId' | 'url' | 'score'> & {
      key?: string
      refId?: number
      url?: string | null
      score?: number
    }
  >
  toolCalls?: Array<{
    name: string
    result: string
    status?: 'completed' | 'failed' | 'pending'
  }>
  imageRequest?: { prompt: string; proposal?: { conversationId: string; slide: number } }
  imageRequests?: Array<{
    prompt: string
    proposal?: { conversationId: string; slide: number }
  }>
  [key: string]: unknown
}

export interface DesktopChatSessionInput {
  conversationId: string
  turnId: string
  projectId: string | null
  userMessage: GenerationMessage
  query: string
  history: { role: string; content: string }[]
  noMemory: boolean
  thinking: boolean
  images: string[]
}

export interface DesktopChatSessionResult {
  turn: ChatTurn
  response: RagChatResultContract
}
export interface DesktopToolChatSessionInput extends DesktopChatSessionInput {
  connectors: boolean
  allMemory: boolean
  imageAvailable: boolean
}

export interface DesktopToolChatSessionResult {
  turn: ChatTurn
  response: DesktopToolChatResponse
}

interface TurnExecution {
  input: DesktopChatSessionInput
  route: 'rag' | 'tools'
  response?: RagChatResultContract
  toolResponse?: DesktopToolChatResponse
}

interface StreamHub {
  listeners: Set<(event: DesktopChatStreamEvent) => void>
  stop?: () => void
}

const STREAM_HUBS = new WeakMap<object, StreamHub>()

/** One IPC subscription fans out to the shared session and the renderer projection. */
export function subscribeDesktopChatStream(
  boundary: DesktopChatSessionBoundary,
  listener: (event: DesktopChatStreamEvent) => void
): () => void {
  let hub = STREAM_HUBS.get(boundary)
  if (!hub) {
    hub = { listeners: new Set() }
    STREAM_HUBS.set(boundary, hub)
  }
  hub.listeners.add(listener)
  if (!hub.stop) {
    hub.stop = boundary.onRagStream((event) => {
      for (const subscriber of hub!.listeners) subscriber(event)
    })
  }
  return () => {
    hub!.listeners.delete(listener)
    if (hub!.listeners.size === 0) {
      hub!.stop?.()
      hub!.stop = undefined
      STREAM_HUBS.delete(boundary)
    }
  }
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

  stopConversation(conversationId: string, reason?: unknown): number {
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
    const cancel = (): void => this.boundary.cancelRag(input.turnId)
    signal?.addEventListener('abort', cancel, { once: true })
    const unsubscribe = subscribeDesktopChatStream(this.boundary, (event) => {
      if (event.streamId !== input.turnId) return
      if (event.type === 'content' && event.text) events?.chunk?.({ content: event.text })
      if (event.type === 'reasoning' && event.text) events?.chunk?.({ reasoning: event.text })
    })
    try {
      if (execution.route === 'tools') {
        if (!this.boundary.toolChat) throw new Error('Desktop tool-chat boundary is unavailable')
        const toolInput = input as DesktopToolChatSessionInput
        const response = await this.boundary.toolChat(input.query, input.history, {
          connectors: toolInput.connectors,
          conversationId: input.conversationId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          allMemory: toolInput.allMemory,
          images: input.images,
          imageAvailable: toolInput.imageAvailable,
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
    } finally {
      unsubscribe()
      signal?.removeEventListener('abort', cancel)
    }
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
