// The single source of truth for which userData directories each data category owns.
// Pure data (no imports) so it is unit-testable and shared by every consumer:
//  - data-privacy's delete paths (clearCategory, getDataSummary), and
//  - the retention archive (backup/retention-archive.ts), which must ZIP exactly the
//    files the delete would remove.
// Two lists here would drift into "backed up X, deleted Y" - that is the bug class
// this module exists to prevent. Dir names are userData-relative; callers resolve
// them against app.getPath('userData').

export type DataCategoryId = 'chats' | 'memories' | 'captures' | 'meetings' | 'images'

export const CATEGORY_DIRS: Record<DataCategoryId, readonly string[]> = {
  chats: ['uploads'],
  memories: ['entity-photos'],
  captures: ['captures'],
  meetings: ['meetings'],
  images: ['generated-images', 'artifacts-library', 'style-thumbs']
}

/** Categories whose deletable payload is files on disk - the ones worth archiving
 *  before a delete. chats/memories are DB-centric and already covered by the full
 *  backup engine (backup/data-port.ts). */
export const ARCHIVABLE_CATEGORIES: readonly DataCategoryId[] = ['captures', 'meetings', 'images']
