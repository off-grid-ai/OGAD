import type {
  ProjectedSyncedTool,
  RecordProvenance,
  SyncedMessageRole,
  SyncedTurnStatus
} from '@offgrid/sync'
import type { AssistantTimelineEntry } from '../../lib/message-persistence'
import type { GenerationMetrics } from '../../../../shared/generation-metrics'
import type {
  RagConversationContract,
  ResponseCutoffContract
} from '../../../../shared/ipc-contracts'
import type { ImageGenerationRequestContract } from '../../../../shared/image-generation-contract'
import type { SearchHit } from '../../types'
import type { IncomingSharedFile } from '@renderer/lib/sync-hooks'
import type { TaskSession } from '@renderer/lib/task-session-store'
import type { Artifact } from '../ArtifactCanvas'
import type { DemoPreset } from '../explore/presetCatalog'

export type RagMemory = { id: number; content?: string; text?: string }
export type RagSummary = { session_id: string; summary?: string; title?: string; app_name?: string }
export type RagEntity = { id: number; name?: string }
export type RagEntityFact = { fact?: string } | string

export type RagContext = {
  notice?: boolean
  masterMemory?: string | null
  memories?: RagMemory[]
  messages?: unknown[]
  summaries?: RagSummary[]
  entities?: RagEntity[]
  entityFacts?: RagEntityFact[]
  unified?: Array<
    Omit<SearchHit, 'key' | 'refId' | 'url' | 'score'> & {
      key?: string
      refId?: number
      url?: string | null
      score?: number
    }
  >
  image?: string
  imageMetadata?: ImageGenerationMetadata
  sources?: { name: string; position: number; score: number }[]
  attachments?: { name: string; kind: string; text?: string; path?: string }[]
  taskGuidance?: {
    taskId: string
    state: 'accepted' | 'applied'
    attachmentNames?: string[]
  }
  taskResult?: {
    taskId: string
    kind: 'web_use' | 'computer_use'
    status: string
    url?: string
  }
  executionApproval?: {
    approvalId: number
    actionId?: string | null
    title: string
    detail?: string | null
    status: string
  }
}

export type ImageGenerationMetadata = {
  width: number
  height: number
  steps: number
  cfgScale: number
  seed: number
  model?: string
}

export type ChatMessage = {
  id: string
  role: SyncedMessageRole
  content: string
  createdAt?: number
  context?: RagContext
  image?: string
  imagePath?: string
  imageMetadata?: ImageGenerationMetadata
  toolCalls?: ProjectedSyncedTool[]
  /** Tool schemas sent to the model for this reply, including tools it did not call. */
  toolsOffered?: string[]
  toolName?: string
  toolCallId?: string
  turnStatus?: SyncedTurnStatus
  /** The app said this ("Model loaded: …"), not the model. Drawn as a quiet marker, never a bubble. */
  notice?: boolean
  /** What this turn's reasoning block is called, when it named itself ("Enhanced prompt"). */
  reasoningLabel?: string
  generationTimeMs?: number
  /** How the generation performed. Shown under the answer when the user asks to see details. */
  metrics?: GenerationMetrics
  provenance?: RecordProvenance
  reasoning?: string
  timeline?: AssistantTimelineEntry[]
  /** Keep the live Thinking row visible before the first reasoning token arrives. */
  reasoningRequested?: boolean
  cutoff?: ResponseCutoffContract
  imageMemoryRetry?: {
    request: ImageGenerationRequestContract
    prompt: string
    conversationId: string
    projectId: string | null
  }
  streaming?: boolean
  activity?: { kind: string; counts?: Record<string, number>; name?: string }
  attachments?: { name: string; kind: string; text?: string; path?: string }[]
  variants?: string[]
  variantIndex?: number
  audioUrl?: string
  audioDuration?: number
}

export type ChatMode = 'ask' | 'image'

export type ImageProgress = {
  step: number
  total: number
  secPerStep: number
  preview?: string
  phase?: 'sampling' | 'decoding'
}

export type AskBlock = { question: string; options: string[]; multiSelect: boolean }

export type Attachment = {
  id: string
  name: string
  kind: 'text' | 'pdf' | 'docx' | 'image' | 'audio' | 'video' | 'pasted'
  text: string
  path?: string
  mimeType?: string
  fileSize?: number
  createdAt?: string
  preview?: string
  status: 'loading' | 'ready' | 'error'
  error?: string
}

export type StoredAttachment = { name: string; kind: string; text?: string; path?: string }
export type Conversation = RagConversationContract
export type ConversationListRow =
  | { kind: 'group'; key: string; label: string }
  | { kind: 'conversation'; key: string; conversation: Conversation }
export type ProjectLite = { id: string; name: string }

export type RawRagMessage = {
  uuid?: unknown
  id?: unknown
  role: SyncedMessageRole
  content: string
  context?: unknown
  created_at?: string
  origin_device_id?: unknown
  origin_device_name?: unknown
}

export type ProjectedTurn = NonNullable<
  ReturnType<typeof import('@offgrid/sync').projectSyncedMessageTurn>
>
export type StoredMessageAttachment = NonNullable<ChatMessage['attachments']>[number]
export type OpenImage = { url: string; path?: string }

export type ContextNavigation = Readonly<{
  onNavigateToMemory?: (memoryId: number) => void
  onNavigateToChat?: (sessionId: string) => void
  onNavigateToMeeting?: (meetingId: number) => void
  onNavigateToEntity?: (entityId: number) => void
  onOpenProject?: (projectId: string) => void
  onSeekReplay?: (timestamp: number) => void
  installedSkillNames?: readonly string[]
  onOpenInstalledSkill?: (name: string) => void
  onOpenSkillPreset?: (preset: DemoPreset) => void
}>

export type UnifiedContextItem = NonNullable<RagContext['unified']>[number]

export type MessageRowState = Readonly<{
  autoPlayId: string | null
  copiedKey: string | null
  editingId: string | null
  loading: boolean
  speakingId: string | null
  speakLoadingId: string | null
  speakError: { id: string; message: string } | null
  ttsEnabled: boolean
  ttsSpeed: number
  latestVoiceAssistantId: string | null
  askSelections: Readonly<Record<string, readonly string[]>>
  incomingFiles: readonly IncomingSharedFile[]
  showGenerationDetails: boolean
  regenerationDisabled: boolean
}>

export type AskOptionSelection = Readonly<{
  message: ChatMessage
  ask: AskBlock
  option: string
  selected: boolean
}>

export type MessageRowActions = Readonly<{
  copy: (text: string, key?: string) => void
  regenerate: (messageId: string) => void
  openImage: (image: OpenImage) => void
  openAttachment: (attachment: StoredMessageAttachment) => void
  startEdit: (message: ChatMessage) => void
  cancelEdit: () => void
  saveEdit: (messageId: string, text: string) => void
  updateVoiceTranscript: (message: ChatMessage, text: string) => Promise<void>
  retryImageMemory: (retry: NonNullable<ChatMessage['imageMemoryRetry']>) => void
  openArtifact: (artifact: Artifact) => void
  selectAskOption: (selection: AskOptionSelection) => void
  submitAsk: (selected: readonly string[]) => void
  speak: (messageId: string, content: string) => void
  voicePlaybackChange: (messageId: string, active: boolean) => void
  selectVariant: (messageId: string, direction: -1 | 1) => void
}>

export type MessageRowProps = Readonly<{
  message: ChatMessage
  onStreamRender?: () => void
  journeyId?: string | null
  nextMessageRole?: SyncedMessageRole
  liveTask?: TaskSession
  timelineThinking?: React.JSX.Element
  workFooter?: React.JSX.Element
  continuation?: React.JSX.Element
  voiceMode: boolean
  state: MessageRowState
  actions: MessageRowActions
  navigation: ContextNavigation
}>
