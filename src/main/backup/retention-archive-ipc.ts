// Electron wiring for archive-before-delete: binds the pure retention-archive
// orchestration to the real userData dir, the save-dialog sink, and clearCategory.
import os from 'node:os'
import { app } from 'electron'
import { ARCHIVABLE_CATEGORIES, type DataCategoryId } from '../data-categories'
import { clearCategory } from '../data-privacy'
import {
  archiveThenClear,
  collectCategoryFiles,
  stageRetentionArchive,
  type ArchiveClearResult
} from './retention-archive'
import { DesktopBackupSink } from './sink'

export async function archiveThenClearCategory(
  id: string,
  olderThanDays?: number
): Promise<ArchiveClearResult> {
  if (!(ARCHIVABLE_CATEGORIES as readonly string[]).includes(id)) {
    return { status: 'failed', error: `Category "${id}" cannot be archived before delete.` }
  }
  const category = id as DataCategoryId
  const sink = new DesktopBackupSink()
  return archiveThenClear({
    collect: () => collectCategoryFiles(app.getPath('userData'), category, olderThanDays),
    stage: (files) =>
      stageRetentionArchive(files, { category, olderThanDays, tempDir: os.tmpdir() }),
    deliver: (zipPath, suggestedName) => sink.deliverFile(zipPath, suggestedName),
    clear: () => clearCategory(category, olderThanDays)
  })
}
