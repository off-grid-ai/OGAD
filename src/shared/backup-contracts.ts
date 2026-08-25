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

// Retention archive (archive-before-delete) - see src/main/backup/retention-archive.ts.
export const RETENTION_ARCHIVE_CLEAR_CHANNEL = 'data:archive-clear'

/** Result of an archive-then-clear run. `canceled` = user closed the save dialog;
 *  nothing was deleted. `failed` = archive or delete failed; on an archive failure
 *  nothing was deleted (fail closed). */
export type RetentionArchiveClearContract =
  | { status: 'cleared'; archivedFiles: number; archivePath?: string }
  | { status: 'canceled' }
  | { status: 'failed'; error: string }
