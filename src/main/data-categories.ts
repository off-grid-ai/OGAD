// The single source of truth for which userData directories each data category owns.
// Pure data (no imports) so it is unit-testable and shared by every consumer:
//  - data-privacy's delete paths (clearCategory, getDataSummary), and
//  - the retention archive (backup/retention-archive.ts), which must ZIP exactly the
//    files the delete would remove.
// Two lists here would drift into "backed up X, deleted Y" - that is the bug class
// this module exists to prevent. Dir names are userData-relative; callers resolve
// them against app.getPath('userData').

import type { DataCategoryId } from '../shared/backup-contracts'

export { ARCHIVABLE_CATEGORIES } from '../shared/backup-contracts'
export type { DataCategoryId }

export const CATEGORY_DIRS: Record<DataCategoryId, readonly string[]> = {
  chats: ['uploads'],
  memories: ['entity-photos'],
  captures: ['captures'],
  meetings: ['meetings'],
  images: ['generated-images', 'artifacts-library', 'style-thumbs']
}
