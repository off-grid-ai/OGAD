// The ONE place core tests write the rows Pro's capture and analysis pipeline owns. Core has no
// writer for these tables and open-core tests cannot import Pro, so tests seed them here, with the
// same columns, defaults and statements as Pro's production writers:
//   observations, frames, observation_frames  pro/main/crm/observations.ts (recordObservation)
//   observation_entities                      pro/main/crm/observation-entity-associations.ts
//   action_items                              pro/main/crm/action-repository.ts
//   entity_edges                              pro/main/crm/observation-relationship-projection.ts
//   meetings                                  pro's meeting recorder
// A Pro contract test runs the real pipeline and these builders on the same input and compares the
// rows, so a schema or default change in Pro turns that test red instead of leaving these stale.
// The guard (mock-guard.ts) allows INSERTs into these tables only in this file.

/** A database handle: better-sqlite3 (the app) or node:sqlite (e2e profiles). */
export interface CaptureDb {
  prepare(sql: string): {
    run(...values: unknown[]): { lastInsertRowid: number | bigint }
    all(...values: unknown[]): unknown[]
  }
}

/**
 * Insert Pro's values for `table`, keeping only the columns this database has: a core-only profile
 * carries the older capture schema, and Pro's migrations add the rest. `CURRENT_TIMESTAMP` values
 * are written as SQL, as Pro's COALESCE does.
 */
function insertRow(
  db: CaptureDb,
  table: string,
  row: Record<string, unknown>,
  verb = 'INSERT'
): number {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  const entries = Object.entries(row).filter(([column]) => present.has(column))
  const values = entries.map(([, value]) => (value === NOW ? 'CURRENT_TIMESTAMP' : '?'))
  const info = db
    .prepare(
      `${verb} INTO ${table} (${entries.map(([column]) => column).join(', ')}) VALUES (${values.join(', ')})`
    )
    .run(...entries.filter(([, value]) => value !== NOW).map(([, value]) => value))
  return Number(info.lastInsertRowid)
}

/** A column Pro fills with the insert time (COALESCE(?, CURRENT_TIMESTAMP)). */
const NOW = Symbol('CURRENT_TIMESTAMP')

export const OBSERVATION_COLUMNS = [
  'summary',
  'surface',
  'surface_app',
  'url',
  'category',
  'source_session_id',
  'source_key',
  'engagement',
  'salience',
  'ts'
] as const

export const FRAME_COLUMNS = [
  'ts',
  'surface',
  'app',
  'window_title',
  'url',
  'image_path',
  'text',
  'source'
] as const

export interface ObservationFixture {
  summary: string
  surface?: string | null
  surfaceApp?: string | null
  url?: string | null
  category?: string
  sourceSessionId?: string | null
  sourceKey?: string | null
  engagement?: number
  salience?: number
  /** SQLite datetime text; the insert time when omitted, as Pro does. */
  ts?: string | null
}

/** One observation, as recordObservation inserts a new one. Returns its id. */
export function writeObservation(db: CaptureDb, input: ObservationFixture): number {
  return insertRow(db, 'observations', {
    summary: input.summary,
    surface: input.surface ?? null,
    surface_app: input.surfaceApp ?? null,
    url: input.url ?? null,
    category: input.category ?? 'work',
    source_session_id: input.sourceSessionId ?? null,
    source_key: input.sourceKey ?? null,
    engagement: input.engagement ?? 0,
    salience: input.salience ?? 0,
    ts: input.ts ?? NOW
  })
}

export interface FrameFixture {
  ts?: string | null
  surface?: string | null
  app?: string | null
  windowTitle?: string | null
  url?: string | null
  imagePath?: string | null
  text?: string | null
  source?: string
}

/** One captured frame, as recordObservation attaches its evidence frames. Returns its id. */
export function writeFrame(db: CaptureDb, input: FrameFixture): number {
  return insertRow(db, 'frames', {
    ts: input.ts ?? NOW,
    surface: input.surface ?? null,
    app: input.app ?? null,
    window_title: input.windowTitle ?? null,
    url: input.url ?? null,
    image_path: input.imagePath ?? null,
    text: input.text ?? null,
    source: input.source ?? 'vision'
  })
}

/** The keyword index row Pro's schema trigger keeps for an observation, for test schemas that
 *  create the observation tables without that trigger. */
export function indexObservation(db: CaptureDb, observationId: number, summary: string): void {
  db.prepare('INSERT INTO observation_fts(rowid, summary) VALUES (?, ?)').run(
    observationId,
    summary
  )
}

export function linkObservationFrame(db: CaptureDb, observationId: number, frameId: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO observation_frames (observation_id, frame_id) VALUES (?, ?)'
  ).run(observationId, frameId)
}

export function linkObservationEntity(
  db: CaptureDb,
  observationId: number,
  entityId: number,
  role: string | null = null
): void {
  insertRow(
    db,
    'observation_entities',
    { observation_id: observationId, entity_id: entityId, role },
    'INSERT OR IGNORE'
  )
}

export interface MeetingFixture {
  title: string
  summary?: string | null
  transcript?: string | null
  audioPath?: string | null
  /** Milliseconds since the epoch. */
  startedAt: number
  endedAt?: number | null
  durationSec?: number | null
}

/** One recorded meeting. Returns its id. */
export function writeMeeting(db: CaptureDb, input: MeetingFixture): number {
  return insertRow(db, 'meetings', {
    title: input.title,
    transcript: input.transcript ?? null,
    summary: input.summary ?? null,
    audio_path: input.audioPath ?? null,
    started_at: input.startedAt,
    ended_at: input.endedAt ?? null,
    duration_sec: input.durationSec ?? null,
    created_at: input.startedAt
  })
}

export interface ActionItemFixture {
  text: string
  rawText?: string | null
  due?: string | null
  dueAt?: number | null
  entityName?: string | null
  entityId?: number | null
  sourceApp?: string | null
  sourceSummary?: string | null
  sourceTs?: number | null
  confidence?: number
  status?: string
  createdAt?: number
}

/** One action item, as the action repository inserts it. Returns its id. */
export function writeActionItem(db: CaptureDb, input: ActionItemFixture): number {
  return insertRow(db, 'action_items', {
    text: input.text,
    raw_text: input.rawText ?? input.text,
    due: input.due ?? null,
    due_at: input.dueAt ?? null,
    entity_name: input.entityName ?? null,
    entity_id: input.entityId ?? null,
    source_app: input.sourceApp ?? null,
    source_summary: input.sourceSummary ?? null,
    source_ts: input.sourceTs ?? null,
    confidence: input.confidence ?? 0.8,
    status: input.status ?? 'open',
    created_at: input.createdAt ?? Date.now()
  })
}

/** A relationship between two entities, as the relationship projection writes one. */
export function writeEntityEdge(
  db: CaptureDb,
  input: { source: number; target: number; type?: string; weight?: number; evidenceCount?: number }
): void {
  db.prepare(
    `INSERT OR IGNORE INTO entity_edges (source_entity_id, target_entity_id, type, weight, evidence_count)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    input.source,
    input.target,
    input.type ?? 'cooccurrence',
    input.weight ?? 1,
    input.evidenceCount ?? 1
  )
}

/** A fact about an entity, as entity analysis records one. */
export function writeEntityFact(
  db: CaptureDb,
  input: { entityId: number; fact: string; sourceSessionId?: string | null }
): void {
  insertRow(db, 'entity_facts', {
    entity_id: input.entityId,
    fact: input.fact,
    source_session_id: input.sourceSessionId ?? null
  })
}
