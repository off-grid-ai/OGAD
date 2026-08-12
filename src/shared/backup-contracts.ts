export const BACKUP_EXPORT_ALL_CHANNEL = 'backup:export-all'
export const BACKUP_IMPORT_CHANNEL = 'backup:import'

export interface BackupDeliveryContract {
  canceled: boolean
  path?: string
}

export interface BackupRestoreSummaryContract {
  projectsAdded: number
  conversationsAdded: number
  messagesAdded: number
  documentsAdded: number
}
