/** Electron IPC payloads shared by main, preload, and renderer type-checks. */
import type { GuidedSetupProgress, RuntimeModel } from '@offgrid/models'
import type { IndexStage, SetupReadiness } from '@offgrid/application'

export interface ModelSetupStatusContract extends SetupReadiness {
  readonly downloaded: boolean
  readonly modelsDir: string
}
import type { GenerationMetrics } from './generation-metrics'

export interface UserProfileContract {
  role?: string
  companySize?: string
  aiUsageFrequency?: string
  primaryTools?: string[]
  painPoints?: string[]
  primaryUseCase?: string
  privacyConcern?: string
  expectedBenefit?: string
  referralSource?: string
  completedAt?: string
}

export interface RagConversationContract {
  id: string
  title: string | null
  project_id?: string | null
  origin_device_id?: string | null
  origin_device_name?: string | null
  created_at: string
  updated_at: string
  message_count?: number
  /** The last turn, for the chat list's one-line preview (see chatListPreviewLine). */
  last_role?: string | null
  last_content?: string | null
}

export interface RagMessageContract {
  id: number
  uuid?: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  context: string | null
  origin_device_id?: string | null
  origin_device_name?: string | null
  created_at: string
}

export interface ResponseCutoffContract {
  reason: 'max_tokens'
  maxTokens: number
}

export interface RagChatResultContract {
  answer: string
  context?: Record<string, unknown>
  cutoff?: ResponseCutoffContract
  /** How the generation performed, when the run was measured. */
  metrics?: GenerationMetrics
  /** The route that produced the answer, after any fallback. */
  model?: RuntimeModel
}

export const PROJECT_INDEX_PROGRESS_CHANNEL = 'projects:index-progress'

/**
 * Payload of `projects:index-progress`, sent once per indexing stage while a knowledge-base
 * document is added. `stage` is the `@offgrid/rag` IndexStage; `error` exists only on the
 * terminal `error` stage the main process adds when indexing throws.
 */
export type ProjectIndexProgressContract =
  | { projectId: string; name: string; stage: IndexStage }
  | { projectId: string; name: string; stage: 'error'; error: string }

export const PROJECT_DOCUMENTS_CHANGED_CHANNEL = 'projects:documents-changed'

/** Payload of `projects:documents-changed`: a knowledge-base project whose document list changed. */
export interface ProjectDocumentsChangedContract {
  projectId: string
}

export const SETUP_PROGRESS_CHANNEL = 'setup:progress'

/** Payload of `setup:progress`: one guided-setup step, sent to the surface that started setup. */
export type SetupProgressContract = GuidedSetupProgress

export const UPDATE_DOWNLOADED_CHANNEL = 'update:downloaded'

/** Payload of `update:downloaded`: the app version staged and ready to install on next quit. */
export interface UpdateDownloadedContract {
  version: string
}

/** One reply still owned by the main process, used to reattach chat UI after navigation. */
export interface ActiveChatStreamContract {
  streamId: string
  conversationId: string
  messageId?: string
  content: string
  reasoning: string
  /** The caller asked the remote/local model for thinking, even if no readable token arrived yet. */
  reasoningRequested: boolean
  phase:
    | 'waiting'
    | 'thinking'
    | 'answering'
    | 'loading_model'
    | 'loading_image_model'
    | 'generating_image'
  tools?: Array<{
    name: string
    status: 'running' | 'completed' | 'failed' | 'pending'
    result?: string
  }>
}

export interface PermissionStatusContract {
  accessibility: boolean
  screenRecording: boolean
  localNetwork: boolean
  allGranted: boolean
}

/** Status values rendered by Settings -> System health. Process state, installed
 * one-shot helpers, and TCC grants are intentionally distinct: calling every
 * usable thing "Running" made the panel claim idle helpers and permissions were
 * processes. */
export type SystemHealthComponentStatusContract =
  | 'ready'
  | 'starting'
  | 'down'
  | 'not_installed'
  | 'installed'
  | 'granted'
  | 'denied'

/** User-facing labels are part of the IPC contract so main and renderer cannot
 * independently reinterpret the same status record. */
export const SYSTEM_HEALTH_STATUS_LABELS: Record<SystemHealthComponentStatusContract, string> = {
  ready: 'Running',
  starting: 'Starting',
  down: 'Error',
  not_installed: 'Not set up',
  installed: 'Installed',
  granted: 'Granted',
  denied: 'Permission needed'
}

export interface SystemHealthComponentContract {
  id: string
  label: string
  status: SystemHealthComponentStatusContract
  detail?: string
  port?: number
  /** True if the renderer can offer a restart affordance for this component. */
  canRestart?: boolean
}

export interface SystemHealthContract {
  ramGb: number
  activeModel: string | null
  components: SystemHealthComponentContract[]
}

export interface CacheCleanupResultContract {
  success: true
  /** HTTP cache bytes reclaimed when Electron can measure them; null otherwise. */
  freedBytes: number | null
}

export const CACHE_CLEANUP_CHANNEL = 'storage:clear-cache'

/**
 * Result of `models:import` (file picker -> validate -> copy -> register).
 * Exclusive union: the picker was dismissed, the GGUF was registered, or import failed.
 */
export type ModelImportResultContract =
  | {
      readonly canceled: true
      readonly success?: never
      readonly error?: never
      readonly id?: never
    }
  | { readonly canceled?: never; readonly success: true; readonly id: string }
  | {
      readonly canceled?: never
      readonly success: false
      readonly error: string
      readonly id?: never
    }

export type ArtifactKindContract = 'html' | 'svg' | 'mermaid' | 'react' | 'text' | 'image'
