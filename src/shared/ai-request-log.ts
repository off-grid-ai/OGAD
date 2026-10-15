export const AI_MODALITIES = ['text', 'image', 'tts', 'stt', 'embedding'] as const
export type AIModality = (typeof AI_MODALITIES)[number]
type AIRequestStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface AIRequestSummary {
  id: string
  parentId?: string
  modality: AIModality
  source: string
  model?: string
  backend?: string
  status: AIRequestStatus
  startedAt: number
  finishedAt?: number
  durationMs?: number
  preview: string
  error?: string
}
export interface AIRequestRecord extends AIRequestSummary {
  request?: unknown
  effectiveRequest?: unknown
  response?: unknown
  metrics?: Record<string, unknown>
  attachments?: AILogAttachment[]
}
export interface AILogAttachment {
  id: string
  mime: string
  bytes: number
  label: string
}
export interface AILogQuery {
  search?: string
  modality?: AIModality
  status?: AIRequestStatus
  hardware?: 'gpu' | 'cpu' | 'unknown'
  sort?: 'newest' | 'oldest' | 'slowest'
  since?: number
  minDurationMs?: number
  offset?: number
  limit?: number
}
export interface AILogPage {
  rows: AIRequestSummary[]
  total: number
  storageError?: string
}
export const AI_LOG_POLICY = {
  maxRecords: 5000,
  maxAgeDays: 7,
  maxBytes: 256 * 1024 * 1024,
  maxAttachmentBytes: 8 * 1024 * 1024,
  maxPayloadChars: 256 * 1024
} as const
