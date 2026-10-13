import type React from 'react'
import type { DemoPreset } from '../explore/presetCatalog'
import type { ChatVoicePhase } from '../use-chat-voice-turns'

/** Something asked of God's chat from outside it: a question, or the microphone. */
export interface GodChatRequest {
  /** Increments for every request, so the same words twice still count. */
  readonly count: number
  /** Ask this, as if typed and sent. */
  readonly ask?: string
  /** Start listening, or start and stop (Ares and the microphone beside it). */
  readonly listen?: 'start' | 'toggle' | 'stop'
}

/** What God's chat is doing, for Ares to show. */
export interface GodChatState {
  readonly thinking: boolean
  readonly speaking: boolean
  readonly voicePhase: ChatVoicePhase
}

/**
 * Chat as God: the same conversation, message actions, voice and conversation list, holding God's
 * conversations only. God acts with Web Use and Computer Use, reads every connected account and
 * all memory, and takes what it knows right now with every question. Generation details and the
 * tools-sent list are not shown.
 */
export interface GodChatOptions {
  /** The companion's name, shown as the chat's title. */
  readonly name: string
  /** What God knows right now and how it should answer, added to every turn. */
  readonly context: () => string
  /** The user's standing rules for God, sent whole with every turn (never cut with the context). */
  readonly rules?: () => readonly string[]
  /** Voice mode speaks every answer and keeps listening; chat mode only writes. */
  readonly voiceMode: boolean
  readonly request: GodChatRequest
  readonly onStateChange?: (state: GodChatState) => void
  /**
   * What an empty conversation shows instead of the plain hero: what this assistant can do and
   * things to ask. `ask` sends a prompt as if typed.
   */
  readonly welcome?: (ask: (prompt: string) => void) => React.ReactNode
  /** How its turns are shown (God shows reactions on your messages). */
  readonly presentMessages?: <
    T extends {
      role: string
      content: string
      turnStatus?: string
      toolCalls?: ReadonlyArray<{ status: string }>
    }
  >(
    messages: readonly T[]
  ) => Array<T & { reactions?: readonly string[] }>
}

export interface MemoryChatProps {
  readonly onNavigateToMemory?: (memoryId: number) => void
  readonly onNavigateToChat?: (sessionId: string) => void
  readonly onNavigateToMeeting?: (meetingId: number) => void
  readonly onNavigateToEntity?: (entityId: number) => void
  /** Open the Projects screen focused on this chat's linked project. */
  readonly onOpenProject?: (projectId: string) => void
  /** Open the Replay screen seeked to a capture's moment (epoch ms). */
  readonly onSeekReplay?: (ts: number) => void
  /** Open the catalog-owned setup/run surface for a skill mention. */
  readonly onOpenSkillPreset?: (preset: DemoPreset) => void
  /** Open connector settings from an Explore intake recommendation. */
  readonly onOpenConnectors?: () => void
  /** Open the Pro journey when a free user selects Assistant. */
  readonly onOpenAssistantUpgrade?: () => void
  /** Open a specific conversation, or start a new one scoped to a project. */
  readonly openTarget?: Readonly<{
    conversationId?: string
    approvalId?: number
    projectId?: string
    openGallery?: boolean
    /** Start a fresh chat with this Explore preset's intake form. */
    presetId?: string
    /** Open the composer with this text. The user still confirms the send. */
    draftPrompt?: string
  }> | null
  readonly onTargetConsumed?: () => void
  /** Keep the surrounding task workspace scoped to the conversation shown here. */
  readonly onActiveConversationChange?: (conversationId: string | null) => void
  /** Let the app hide global navigation while a task uses its immersive detail view. */
  readonly onTaskDetailModeChange?: (detailOpen: boolean) => void
  /** Chat as God (see GodChatOptions). Absent: the Chat screen. */
  readonly god?: GodChatOptions
}
