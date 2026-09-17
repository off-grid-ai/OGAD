import type { DemoPreset } from '../explore/presetCatalog'

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
}
