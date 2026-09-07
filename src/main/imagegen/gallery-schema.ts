import type Database from 'better-sqlite3-multiple-ciphers'

export type GeneratedImageGalleryStateRow = { revision: number; images_json: string }

export function createGeneratedImageGallerySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generated_image_gallery_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL,
      images_json TEXT NOT NULL
    );
    INSERT OR IGNORE INTO generated_image_gallery_state(singleton, revision, images_json)
    VALUES (1, 0, '[]');
    CREATE TABLE IF NOT EXISTS generated_image_gallery_migrations (
      migration_id TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS generated_image_byte_deletions (
      image_id TEXT NOT NULL CHECK (trim(image_id) <> ''),
      deletion_operation_id TEXT NOT NULL CHECK (trim(deletion_operation_id) <> ''),
      image_path TEXT NOT NULL CHECK (trim(image_path) <> ''),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      owner_kind TEXT NOT NULL DEFAULT 'local' CHECK (owner_kind IN ('local', 'provenance')),
      release_scope TEXT,
      quarantine_path TEXT,
      PRIMARY KEY (image_id, deletion_operation_id)
    );
    CREATE TABLE IF NOT EXISTS generated_image_byte_release_receipts (
      image_id TEXT NOT NULL CHECK (trim(image_id) <> ''),
      deletion_operation_id TEXT NOT NULL CHECK (trim(deletion_operation_id) <> ''),
      image_path TEXT NOT NULL CHECK (trim(image_path) <> ''),
      PRIMARY KEY (image_id, deletion_operation_id)
    );
    CREATE TABLE IF NOT EXISTS generated_image_release_scopes (
      image_id TEXT PRIMARY KEY CHECK (trim(image_id) <> ''),
      release_scope TEXT NOT NULL CHECK (trim(release_scope) <> '')
    );
    CREATE TABLE IF NOT EXISTS generated_image_release_waiters (
      release_scope TEXT NOT NULL CHECK (trim(release_scope) <> ''),
      image_id TEXT NOT NULL CHECK (trim(image_id) <> ''),
      deletion_operation_id TEXT NOT NULL CHECK (trim(deletion_operation_id) <> ''),
      PRIMARY KEY (release_scope, image_id, deletion_operation_id)
    );
    CREATE INDEX IF NOT EXISTS generated_image_release_waiters_image
    ON generated_image_release_waiters(image_id);
  `)
  const columns = db.prepare('PRAGMA table_info(generated_image_byte_deletions)').all() as Array<{
    name: string
  }>
  const waiterColumns = db
    .prepare('PRAGMA table_info(generated_image_release_waiters)')
    .all() as Array<{ name: string }>
  const receiptColumns = db
    .prepare('PRAGMA table_info(generated_image_byte_release_receipts)')
    .all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'owner_kind')) {
    db.exec(
      `ALTER TABLE generated_image_byte_deletions
       ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'local'`
    )
  }
  if (!columns.some((column) => column.name === 'release_scope')) {
    db.exec(`ALTER TABLE generated_image_byte_deletions ADD COLUMN release_scope TEXT`)
  }
  if (!columns.some((column) => column.name === 'quarantine_path')) {
    db.exec(`ALTER TABLE generated_image_byte_deletions ADD COLUMN quarantine_path TEXT`)
  }
  if (
    !columns.some((column) => column.name === 'deletion_operation_id') ||
    !waiterColumns.some((column) => column.name === 'deletion_operation_id') ||
    !receiptColumns.some((column) => column.name === 'deletion_operation_id')
  ) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE generated_image_byte_deletions_v2 (
          image_id TEXT NOT NULL, deletion_operation_id TEXT NOT NULL, image_path TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, owner_kind TEXT NOT NULL DEFAULT 'local',
          release_scope TEXT, quarantine_path TEXT, PRIMARY KEY (image_id, deletion_operation_id));
        CREATE TABLE generated_image_release_waiters_v2 (
          release_scope TEXT NOT NULL, image_id TEXT NOT NULL, deletion_operation_id TEXT NOT NULL,
          PRIMARY KEY (release_scope, image_id, deletion_operation_id));
        CREATE TABLE generated_image_byte_release_receipts_v2 (
          image_id TEXT NOT NULL, deletion_operation_id TEXT NOT NULL, image_path TEXT NOT NULL,
          PRIMARY KEY (image_id, deletion_operation_id));
      `)
      const operation = (row: Record<string, unknown>): string =>
        typeof row.deletion_operation_id === 'string' && row.deletion_operation_id.trim()
          ? row.deletion_operation_id
          : `legacy:${String(row.image_id)}`
      const intents = db.prepare('SELECT * FROM generated_image_byte_deletions').all() as Record<
        string,
        unknown
      >[]
      const putIntent = db.prepare(`INSERT OR IGNORE INTO generated_image_byte_deletions_v2
        (image_id, deletion_operation_id, image_path, attempt_count, last_error, owner_kind,
         release_scope, quarantine_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const row of intents)
        putIntent.run(
          row.image_id,
          operation(row),
          row.image_path,
          row.attempt_count,
          row.last_error,
          row.owner_kind,
          row.release_scope,
          row.quarantine_path
        )
      const putWaiter = db.prepare(`INSERT OR IGNORE INTO generated_image_release_waiters_v2
        (release_scope, image_id, deletion_operation_id) VALUES (?, ?, ?)`)
      for (const row of db.prepare('SELECT * FROM generated_image_release_waiters').all() as Record<
        string,
        unknown
      >[]) {
        const matches = intents.filter((intent) => intent.image_id === row.image_id)
        for (const match of matches.length ? matches : [row])
          putWaiter.run(row.release_scope, row.image_id, operation(match))
      }
      const putReceipt = db.prepare(`INSERT OR IGNORE INTO generated_image_byte_release_receipts_v2
        (image_id, deletion_operation_id, image_path) VALUES (?, ?, ?)`)
      for (const row of db
        .prepare('SELECT * FROM generated_image_byte_release_receipts')
        .all() as Record<string, unknown>[]) {
        putReceipt.run(row.image_id, operation(row), row.image_path)
      }
      const migratedIntentCount = db
        .prepare('SELECT COUNT(*) count FROM generated_image_byte_deletions_v2')
        .get() as { count: number }
      if (migratedIntentCount.count < intents.length) {
        throw new Error('Generated-image intent operation migration lost rows.')
      }
      db.exec(`
        ALTER TABLE generated_image_byte_deletions RENAME TO generated_image_byte_deletions_legacy;
        ALTER TABLE generated_image_release_waiters RENAME TO generated_image_release_waiters_legacy;
        ALTER TABLE generated_image_byte_release_receipts RENAME TO generated_image_byte_release_receipts_legacy;
        ALTER TABLE generated_image_byte_deletions_v2 RENAME TO generated_image_byte_deletions;
        ALTER TABLE generated_image_release_waiters_v2 RENAME TO generated_image_release_waiters;
        ALTER TABLE generated_image_byte_release_receipts_v2 RENAME TO generated_image_byte_release_receipts;
      `)
    })()
  }
  db.transaction(() => {
    db.exec(`
      INSERT OR IGNORE INTO generated_image_release_waiters(release_scope, image_id, deletion_operation_id)
      SELECT scope.release_scope, scope.image_id, intent.deletion_operation_id
      FROM generated_image_release_scopes scope
      JOIN generated_image_byte_deletions intent ON intent.image_id = scope.image_id;
      INSERT OR IGNORE INTO generated_image_release_waiters(release_scope, image_id, deletion_operation_id)
      SELECT release_scope, image_id, deletion_operation_id FROM generated_image_byte_deletions
      WHERE release_scope IS NOT NULL;
      DELETE FROM generated_image_release_scopes;
      UPDATE generated_image_byte_deletions SET release_scope = NULL
      WHERE release_scope IS NOT NULL;
    `)
  })()
}

export function readGeneratedImageGalleryState(
  db: Database.Database
): GeneratedImageGalleryStateRow {
  return db
    .prepare('SELECT revision, images_json FROM generated_image_gallery_state WHERE singleton = 1')
    .get() as GeneratedImageGalleryStateRow
}
