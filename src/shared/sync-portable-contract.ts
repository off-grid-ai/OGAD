import type { CollisionPolicy } from '@offgrid/sync/portable'

export const SYNC_PORTABLE_CHANNELS = {
  exportAll: 'sync:portable:export-all',
  exportProject: 'sync:portable:export-project',
  exportConversation: 'sync:portable:export-conversation',
  importPicker: 'sync:portable:import-picker'
} as const

export interface SyncPortableExportResult {
  canceled: boolean
  savedPath?: string
}

export interface SyncPortableImportSummary {
  projectsAdded: number
  projectsUpdated: number
  conversationsAdded: number
  conversationsUpdated: number
  messagesAdded: number
  messagesUpdated: number
  documentsAdded: number
  documentsUpdated: number
  skipped: number
  warnings: string[]
}

export interface SyncPortableApi {
  exportAll(): Promise<SyncPortableExportResult | null>
  exportProject(projectId: string): Promise<SyncPortableExportResult | null>
  exportConversation(conversationId: string): Promise<SyncPortableExportResult | null>
  importPicker(collisionPolicy?: CollisionPolicy): Promise<SyncPortableImportSummary | null>
}
