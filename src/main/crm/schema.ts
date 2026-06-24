// CRM-for-everything layer, built ON TOP of the existing entity tables
// (entities / entity_facts / entity_edges / entity_sessions). Adds:
//   - observations: the distilled "what happened" unit, tagged with surface + time
//   - observation_entities: many-to-many link observation <-> entity (the spine)
//   - entity_aliases: durable resolution rules (email/handle/name) learned from
//     auto-resolution AND user corrections
//   - entity_merge_log: reversible record of merges
//   - entity_merge_suggestions: the low-confidence review queue (ask, don't guess)
// Additive + idempotent, mirroring the rag store's migrate() pattern.

import { getDB } from '../database';

let migrated = false;

export function migrateCrm(): void {
  if (migrated) return;
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      summary TEXT NOT NULL,
      surface TEXT,                      -- canonical surface (e.g. 'Gmail', 'Slack')
      surface_app TEXT,                  -- raw app/bundle (e.g. 'Google Chrome')
      url TEXT,
      source_session_id TEXT,
      memory_id INTEGER,                 -- the memory this was derived from (incremental sync)
      category TEXT NOT NULL DEFAULT 'work', -- work | communication | consumption | other
      engagement REAL NOT NULL DEFAULT 0,-- behavioral signal 0..1 (dwell + input)
      salience REAL NOT NULL DEFAULT 0,  -- content signal 0..1 (LLM judgement)
      ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_observations_memory ON observations(memory_id);
    CREATE INDEX IF NOT EXISTS idx_observations_ts ON observations(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_observations_surface ON observations(surface);

    CREATE TABLE IF NOT EXISTS observation_entities (
      observation_id INTEGER NOT NULL,
      entity_id INTEGER NOT NULL,
      role TEXT,                         -- optional: 'subject' | 'mentioned' | ...
      UNIQUE(observation_id, entity_id),
      FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE,
      FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_obs_entities_entity ON observation_entities(entity_id);

    CREATE TABLE IF NOT EXISTS entity_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'name', -- 'name' | 'email' | 'handle' | 'phone' | 'url'
      value TEXT NOT NULL COLLATE NOCASE,
      source TEXT NOT NULL DEFAULT 'auto', -- 'auto' | 'user'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(kind, value),
      FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity ON entity_aliases(entity_id);

    CREATE TABLE IF NOT EXISTS entity_merge_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kept_entity_id INTEGER NOT NULL,
      merged_name TEXT NOT NULL,
      merged_type TEXT,
      detail TEXT,                       -- JSON snapshot for potential undo
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS entity_merge_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_a INTEGER NOT NULL,
      entity_b INTEGER NOT NULL,
      reason TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'merged' | 'dismissed'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entity_a, entity_b)
    );

    -- Raw capture evidence beneath an observation (Entity -> App -> frames).
    -- Sparse until native full-surface capture lands; the hierarchy is ready now.
    CREATE TABLE IF NOT EXISTS frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts DATETIME DEFAULT CURRENT_TIMESTAMP,
      surface TEXT,
      app TEXT,
      window_title TEXT,
      url TEXT,
      image_path TEXT,                   -- downscaled screenshot on disk (optional)
      text TEXT,                         -- AX/OCR extracted text (optional)
      source TEXT                        -- 'ax' | 'ocr' | 'message' | ...
    );
    CREATE INDEX IF NOT EXISTS idx_frames_ts ON frames(ts DESC);

    CREATE TABLE IF NOT EXISTS observation_frames (
      observation_id INTEGER NOT NULL,
      frame_id INTEGER NOT NULL,
      UNIQUE(observation_id, frame_id),
      FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE,
      FOREIGN KEY(frame_id) REFERENCES frames(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_obs_frames_obs ON observation_frames(observation_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS observation_fts USING fts5(
      summary, content='observations', content_rowid='id'
    );
  `);

  // Keep the FTS mirror in sync with observations.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observation_fts(rowid, summary) VALUES (new.id, new.summary);
    END;
    CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observation_fts(observation_fts, rowid, summary) VALUES ('delete', old.id, old.summary);
    END;
    CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observation_fts(observation_fts, rowid, summary) VALUES ('delete', old.id, old.summary);
      INSERT INTO observation_fts(rowid, summary) VALUES (new.id, new.summary);
    END;
  `);

  // First-class entity photo (avatar) + parent for hierarchy (off-grid-ai ->
  // off-grid-mobile). entities table is created in database.ts; add idempotently.
  try {
    db.exec('ALTER TABLE entities ADD COLUMN image_path TEXT');
  } catch {
    /* column already exists */
  }
  try {
    db.exec('ALTER TABLE entities ADD COLUMN parent_id INTEGER');
  } catch {
    /* column already exists */
  }
  // Hidden = archived from feed/timeline views, but still captured + queryable.
  try {
    db.exec('ALTER TABLE entities ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* column already exists */
  }
  // category was added to the observations CREATE later — existing DBs predate it,
  // and CREATE TABLE IF NOT EXISTS won't backfill a column. Add it idempotently,
  // else every recordObservation() throws "no column named category".
  try {
    db.exec("ALTER TABLE observations ADD COLUMN category TEXT NOT NULL DEFAULT 'work'");
  } catch {
    /* column already exists */
  }

  migrated = true;
}
