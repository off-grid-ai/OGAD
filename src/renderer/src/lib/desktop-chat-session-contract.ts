import type { ChatTurn, GenerationMessage } from '@offgrid/models'
import type { ImageGenerationRequestContract } from '../../../shared/image-generation-contract'
import type { RagChatResultContract } from '../../../shared/ipc-contracts'
import type { SearchHit } from '../types'

export interface DesktopChatStreamEvent {
  streamId: string
  type: 'content' | 'reasoning' | 'step' | 'tool_result' | 'done'
  text?: string
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
    status?: 'completed' | 'failed' | 'pending'
  }>
  imageRequest?: { prompt: string; proposal?: { conversationId: string; slide: number } }
  imageRequests?: Array<{
    prompt: string
    proposal?: { conversationId: string; slide: number }
  }>
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
  cancelImageGen?(): void
  toolChat?(
    query: string,
    history: { role: string; content: string }[],
    options: DesktopToolChatOptions
  ): Promise<DesktopToolChatResponse>
  generateImage?(request: DesktopImageGenerationRequest): Promise<DesktopImageGenerationResponse>
  addRagMessage?(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    context?: unknown
  ): Promise<{ id: number; uuid: string }>
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
  userPersistence?: { content: string; context?: unknown }
}

export interface DesktopChatSessionResult {
  turn: ChatTurn
  response: RagChatResultContract
}

export interface DesktopQueuedTurnProjection {
  turnId: string
  text: string
  attachmentCount: number
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

export interface DesktopImageChatSessionInput extends DesktopChatSessionInput {
  request: DesktopImageGenerationRequest
}

export interface DesktopImageChatSessionResult {
  turn: ChatTurn
  response: DesktopImageGenerationResponse
}
