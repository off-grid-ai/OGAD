// The chat transcript's own type model: what a message, its retrieved context, its
// attachments, and the composer's mode are. Every chat surface reads these; MemoryChat
// composes them. Types only - no values, so nothing here can drift into a second owner
// of a rule.
import type {
  ProjectedSyncedTool,
  RecordProvenance,
  SyncedMessageRole,
  SyncedTurnStatus
} from '@offgrid/application'
import type { GenerationMetrics } from '../../../shared/generation-metrics'
import type { RagConversationContract, ResponseCutoffContract } from '../../../shared/ipc-contracts'
import type { DesktopImageMemoryRetry } from '@renderer/lib/desktop-chat-session-contract'
import type { SearchHit } from '../types'

export type RagMemory = { id: number; content?: string; text?: string }
export type RagSummary = { session_id: string; summary?: string; title?: string; app_name?: string }
export type RagEntity = { id: number; name?: string }
export type RagEntityFact = { fact?: string } | string

export type RagContext = {
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
  context?: RagContext
  image?: string
  imagePath?: string
  imageMetadata?: ImageGenerationMetadata
  /** The artifact exists, but its durable Chat projection failed. */
  persistenceWarning?: string
  toolCalls?: ProjectedSyncedTool[]
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
  /** Keep the live Thinking row visible before the first reasoning token arrives. */
  reasoningRequested?: boolean
  cutoff?: ResponseCutoffContract
  imageMemoryRetry?: DesktopImageMemoryRetry
  streaming?: boolean
  activity?: { kind: string; counts?: Record<string, number>; name?: string }
  attachments?: { name: string; kind: string; text?: string; path?: string }[]
  variants?: string[] // regenerated answers (navigate with ‹ ›)
  variantIndex?: number
  audioUrl?: string // voice-mode: recorded clip for a user voice note
  audioDuration?: number // seconds, when known from the recording
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
  path?: string // images: persisted path passed to the vision model
  mimeType?: string
  fileSize?: number
  createdAt?: string
  preview?: string // images: a local object URL shown immediately while processing
  status: 'loading' | 'ready' | 'error'
  error?: string
}

/**
 * The attachments of a persisted user turn, as a send can use them.
 *
 * A turn's attachments had two homes: the composer's transient `attachments` state, cleared the
 * moment the turn was sent, and the row persisted in the message context. Only the first was ever
 * read on the way to the model, so Resend / Regenerate / Edit replayed the TEXT of a turn and
 * silently dropped its images - the model then answered "I don't see an image attached" for a
 * message that visibly had one. The persisted row is the durable home (the files live under
 * uploads/), so every replay path rebuilds from it and the composer state is only ever the source
 * for the FIRST send.
 *
 * Status is 'ready' by construction: a turn only reaches the database once its attachments were.
 * The stored row keeps what a replay needs (name, kind, text, path) and not the composer-only
 * fields, so the id is rebuilt from the path - stable across replays of the same turn.
 */
export type StoredAttachment = { name: string; kind: string; text?: string; path?: string }

export type Conversation = RagConversationContract

export type ProjectLite = { id: string; name: string }
