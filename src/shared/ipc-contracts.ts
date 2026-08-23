/** Electron IPC payloads shared by main, preload, and renderer type-checks. */
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
}

/** One reply still owned by the main process, used to reattach chat UI after navigation. */
export interface ActiveChatStreamContract {
  streamId: string
  conversationId: string
  messageId?: string
  content: string
  reasoning: string
  phase:
    | 'waiting'
    | 'thinking'
    | 'answering'
    | 'loading_model'
    | 'loading_image_model'
    | 'generating_image'
  tools?: Array<{
    name: string
    status: 'running' | 'completed'
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

export type ArtifactKindContract = 'html' | 'svg' | 'mermaid' | 'react' | 'text' | 'image'
