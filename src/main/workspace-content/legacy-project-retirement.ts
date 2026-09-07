import type Database from 'better-sqlite3-multiple-ciphers'

const RETIREMENT_VERSION = 1

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  )
}

function count(db: Database.Database, query: string): number {
  return (db.prepare(query).get() as { count: number }).count
}

/** Retire the legacy project owner only after all of its live relations have canonical parents. */
export function retireLegacyProjectOwner(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_content_legacy_project_retirement (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    completed_at TEXT NOT NULL CHECK (trim(completed_at) <> '')
  )`)
  const checkpointed = Boolean(
    db
      .prepare('SELECT 1 FROM workspace_content_legacy_project_retirement WHERE version = ?')
      .get(RETIREMENT_VERSION)
  )
  // A restored/stale checkpoint cannot make a recreated legacy owner authoritative again. Re-run
  // the verified retirement when the table is present; only checkpoint + absence is complete.
  if (checkpointed && !tableExists(db, 'projects')) {
    return
  }

  db.transaction(() => {
    const hasLegacyProjects = tableExists(db, 'projects')
    const missingProjects = hasLegacyProjects
      ? count(
          db,
          `SELECT COUNT(*) AS count FROM projects legacy
           LEFT JOIN workspace_content_projects canonical ON canonical.id = legacy.id
           WHERE canonical.id IS NULL`
        )
      : 0
    const mismatchedConversations = tableExists(db, 'rag_conversations')
      ? count(
          db,
          `SELECT COUNT(*) AS count FROM rag_conversations legacy
           LEFT JOIN workspace_content_conversations canonical ON canonical.id = legacy.id
           WHERE legacy.project_id IS NOT NULL AND trim(legacy.project_id) <> ''
             AND (canonical.id IS NULL OR canonical.project_id IS NOT legacy.project_id)`
        )
      : 0
    const orphanedDocuments = tableExists(db, 'rag_documents')
      ? count(
          db,
          `SELECT COUNT(*) AS count FROM rag_documents document
           LEFT JOIN workspace_content_projects canonical ON canonical.id = document.project_id
           WHERE canonical.id IS NULL`
        )
      : 0
    if (missingProjects + mismatchedConversations + orphanedDocuments > 0) {
      throw new Error(
        `Legacy project retirement refused: ${String(missingProjects)} projects, ${String(mismatchedConversations)} conversation links, and ${String(orphanedDocuments)} document links are not canonical.`
      )
    }
    if (hasLegacyProjects) db.exec('DROP TABLE projects')
    db.prepare(
      `INSERT OR IGNORE INTO workspace_content_legacy_project_retirement
       (version, completed_at) VALUES (?, ?)`
    ).run(RETIREMENT_VERSION, new Date().toISOString())
  }).immediate()
}
