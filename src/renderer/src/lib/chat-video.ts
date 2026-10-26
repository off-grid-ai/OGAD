import { useSyncExternalStore } from 'react'
import { callHook } from '../bootstrap/hookRegistry'
import type {
  VideoGenerationJobContract,
  VideoGenerationRequestContract,
  VideoGenerationResultContract
} from '../../../shared/video-generation-contract'

/** What chat asks Pro to render. Pro owns generation; core only places the result in chat. */
export type ChatVideoRequest = VideoGenerationRequestContract & {
  conversationId: string
  projectId?: string | null
}

export interface ChatVideoState {
  /** A video model and engine are ready here or on a remote server. */
  available: boolean
  job: VideoGenerationJobContract | null
}

/** Pro registers one controller. Free builds have none, and chat shows no video controls. */
export interface ChatVideoController {
  getState(): ChatVideoState
  subscribe(listener: () => void): () => void
  refresh(): void
  generate(request: ChatVideoRequest): Promise<VideoGenerationResultContract>
  cancel(): Promise<boolean>
  acknowledge(conversationId: string, messageId: string): Promise<boolean>
  /**
   * Before a clip: Pro may take the request as a film (a longer ask, or a person to keep in every
   * shot). Returns the line chat shows when it did, or null to render one clip.
   */
  startFilm?(request: ChatVideoRequest): Promise<{ line: string; storyId: string } | null>
  /** Conversations whose messages changed outside the renderer (a clip finished). */
  onConversationUpdated(listener: (conversationId: string) => void): () => void
}

export const CHAT_VIDEO_HOOK = 'chat.video'

const NONE: ChatVideoState = { available: false, job: null }
const noSubscription = (): (() => void) => () => {}

export function chatVideo(): ChatVideoController | undefined {
  return callHook<ChatVideoController>(CHAT_VIDEO_HOOK)
}

export function useChatVideoState(): ChatVideoState {
  const controller = chatVideo()
  return useSyncExternalStore(
    controller ? controller.subscribe : noSubscription,
    controller ? controller.getState : () => NONE
  )
}

export function requireChatVideo(): ChatVideoController {
  const controller = chatVideo()
  if (!controller) throw new Error('Video needs Off Grid AI Pro.')
  return controller
}
