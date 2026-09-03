import type { ChatTurn, GenerationMessage, RuntimeModel } from '@offgrid/models'
import type { ImageGenerationRequestContract } from '../../../shared/image-generation-contract'
import type { RagChatResultContract } from '../../../shared/ipc-contracts'
import type { SearchHit } from '../types'
import type { GenerationMetrics } from '../../../shared/generation-metrics'

export interface DesktopChatStreamEvent {
  streamId: string
  type: 'content' | 'reasoning' | 'step' | 'tool_result' | 'route' | 'fallback' | 'done'
  text?: string
  /** `route`: the model that took the turn. */
  model?: RuntimeModel
  /** `fallback`: the shared generation moved the turn to another model. */
  fallback?: { failed: RuntimeModel; next: RuntimeModel; reason: string }
}

export interface DesktopImageGenerationResponse {
  dataUrl: string
  path: string
  syncId?: string
  seed?: number
  model?: string
  prompt?: string
}

export interface DesktopImageGenerationRequest extends ImageGenerationRequestContract {
  conversationId: string
  projectId: string | null
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
    status?: 'completed' | 'failed' | 'pending' | 'cancelled'
  }>
  imageRequest?: { prompt: string; proposal?: { conversationId: string; slide: number } }
  imageRequests?: Array<{
    prompt: string
    proposal?: { conversationId: string; slide: number }
  }>
  metrics?: GenerationMetrics
  [key: string]: unknown
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
  /** Plain generation for the compaction summarizer. Absent means Desktop cannot compact. */
  generateText?(
    messages: ReadonlyArray<{ role: string; content: string }>,
    options?: { maxTokens?: number }
  ): Promise<string>
  /** The llama-server window. Absent means Desktop cannot compact. */
  getLlmSettings?(): Promise<{ ctxSize?: number; effectiveCtxSize?: number } | null | undefined>
  cancelImageGen?(): void
  toolChat?(
    query: string,
    history: { role: string; content: string }[],
    options: DesktopToolChatOptions
  ): Promise<DesktopToolChatResponse>
  generateImage?(request: DesktopImageGenerationRequest): Promise<DesktopImageGenerationResponse>
  storeProposalIllustration?(
    conversationId: string,
    slide: number,
    imagePath: string
  ): Promise<unknown>
  addRagMessage?(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    context?: unknown
  ): Promise<{ id: number; uuid: string }>
  truncateRagMessages?(conversationId: string, anchor: DesktopTruncationAnchor): Promise<unknown>
}

interface DesktopChatSessionCommonInput {
  conversationId: string
  turnId: string
  projectId: string | null
  userMessage: GenerationMessage
  query: string
  history: { role: string; content: string }[]
  noMemory: boolean
  /** The user's reasoning toggle for a text turn. Image turns never reason. */
  thinking?: boolean
  images: string[]
  userPersistence?: { content: string; context?: unknown }
  replay?: 'regenerate' | 'edit'
  /** Which persisted rows a replay retires: everything after this message (and the message itself for an edit). */
  invalidationAnchor?: DesktopTruncationAnchor
}

export interface DesktopTruncationAnchor {
  messageId: string
  keepAnchor: boolean
}

export interface DesktopChatSessionInput extends DesktopChatSessionCommonInput {
  kind?: 'chat'
}

export interface DesktopChatSessionResult {
  turn: ChatTurn
  response: RagChatResultContract
  generatedImages: readonly DesktopImageGenerationResponse[]
}

export interface DesktopQueuedTurnProjection {
  turnId: string
  text: string
  attachmentCount: number
}

export interface DesktopToolChatSessionInput extends DesktopChatSessionCommonInput {
  kind: 'tools'
  connectors: boolean
  allMemory: boolean
  imageAvailable: boolean
}

/**
 * The "Run anyway" affordance: an image request the shared memory rule refused, re-runnable with the
 * person's explicit override. One shape for the direct image path and the tool-owned one.
 */
export interface DesktopImageMemoryRetry {
  request: ImageGenerationRequestContract
  prompt: string
  conversationId: string
  projectId: string | null
}

export interface DesktopToolChatSessionResult {
  turn: ChatTurn
  response: DesktopToolChatResponse
  generatedImages: readonly DesktopImageGenerationResponse[]
  /** Set when a tool-owned image was refused for memory; the turn's message offers "Run anyway". */
  imageMemoryRetry?: DesktopImageMemoryRetry
}

export interface DesktopImageChatSessionInput extends DesktopChatSessionCommonInput {
  kind: 'image'
  request: DesktopImageGenerationRequest
}

export interface DesktopImageChatSessionResult {
  turn: ChatTurn
  response: DesktopImageGenerationResponse
  generatedImages: readonly DesktopImageGenerationResponse[]
}

export type DesktopAnyChatSessionInput =
  | DesktopChatSessionInput
  | DesktopToolChatSessionInput
  | DesktopImageChatSessionInput
