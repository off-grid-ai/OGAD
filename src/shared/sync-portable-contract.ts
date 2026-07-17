export const SYNC_PORTABLE_CHANNELS = {
  exportAll: 'sync:portable:export-all',
  summary: 'sync:portable:summary',
  exportProject: 'sync:portable:export-project',
  exportConversation: 'sync:portable:export-conversation',
  importPicker: 'sync:portable:import-picker'
} as const

export interface SyncPortableExportResult {
  canceled: boolean
  savedPath?: string
}

export interface SyncPortableSummary {
  projects: number
  conversations: number
  messages: number
  documents: number
  attachments: number
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
  attachmentsImported: number
  skipped: number
  warnings: string[]
}

export interface SyncPortableApi {
  summary(): Promise<SyncPortableSummary>
  exportAll(): Promise<SyncPortableExportResult | null>
  exportProject(projectId: string): Promise<SyncPortableExportResult | null>
  exportConversation(conversationId: string): Promise<SyncPortableExportResult | null>
  importPicker(): Promise<SyncPortableImportSummary | null>
}
