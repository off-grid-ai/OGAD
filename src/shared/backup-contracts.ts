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

export type DataCategoryId = 'chats' | 'memories' | 'captures' | 'meetings' | 'images'

/** Categories whose deletable payload is files on disk - the ones worth archiving
 *  before a delete. Shared so the renderer offers "Back up & delete" for exactly the
 *  categories the main-process handler accepts. */
export const ARCHIVABLE_CATEGORIES: readonly DataCategoryId[] = ['captures', 'meetings', 'images']

/** Result of an archive-then-clear run. `canceled` = user closed the save dialog;
 *  nothing was deleted. `failed` = archive or delete failed; on an archive failure
 *  nothing was deleted (fail closed). */
export type RetentionArchiveClearContract =
  | { status: 'cleared'; archivedFiles: number; archivePath?: string }
  | { status: 'canceled' }
  | { status: 'failed'; error: string }

// Automatic history cleanup (Phase 2) - a daily job that archives-then-prunes old
// screen captures using the same fail-closed machinery as the manual flow.
// Config is a single app_settings key so the renderer saves it via settings:save.
export const AUTO_CLEANUP_SETTING_KEY = 'autoCleanup'

export interface AutoCleanupConfigContract {
  /** Keep screen history for this many days; 0 = automatic cleanup off. */
  retentionDays: number
  /** Archive old captures to this folder before pruning; null = prune without backup. */
  archiveDir: string | null
}

export const AUTO_CLEANUP_DEFAULTS: AutoCleanupConfigContract = {
  retentionDays: 0,
  archiveDir: null
}

export interface AutoCleanupRunContract {
  /** 'off' = retention disabled, nothing ran. 'failed' = archive or prune failed;
   *  on an archive failure nothing was pruned (fail closed). */
  status: 'off' | 'cleared' | 'failed'
  ranAt: number
  archivedFiles?: number
  archivePath?: string
  error?: string
}

export interface AutoCleanupStatusContract {
  config: AutoCleanupConfigContract
  lastRun: AutoCleanupRunContract | null
}
