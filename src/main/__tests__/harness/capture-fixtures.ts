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
  }
}

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
  const info = db
    .prepare(
      `INSERT INTO observations (summary, surface, surface_app, url, category, source_session_id, source_key, engagement, salience, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
    )
    .run(
      input.summary,
      input.surface ?? null,
      input.surfaceApp ?? null,
      input.url ?? null,
      input.category ?? 'work',
      input.sourceSessionId ?? null,
      input.sourceKey ?? null,
      input.engagement ?? 0,
      input.salience ?? 0,
      input.ts ?? null
    )
  return Number(info.lastInsertRowid)
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
  const info = db
    .prepare(
      `INSERT INTO frames (ts, surface, app, window_title, url, image_path, text, source)
       VALUES (COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.ts ?? null,
      input.surface ?? null,
      input.app ?? null,
      input.windowTitle ?? null,
      input.url ?? null,
      input.imagePath ?? null,
      input.text ?? null,
      input.source ?? 'vision'
    )
  return Number(info.lastInsertRowid)
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
  db.prepare(
    'INSERT OR IGNORE INTO observation_entities (observation_id, entity_id, role) VALUES (?, ?, ?)'
  ).run(observationId, entityId, role)
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
  const info = db
    .prepare(
      `INSERT INTO meetings (title, transcript, summary, audio_path, started_at, ended_at, duration_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.title,
      input.transcript ?? null,
      input.summary ?? null,
      input.audioPath ?? null,
      input.startedAt,
      input.endedAt ?? null,
      input.durationSec ?? null,
      input.startedAt
    )
  return Number(info.lastInsertRowid)
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
  const info = db
    .prepare(
      `INSERT INTO action_items
         (text, raw_text, due, due_at, entity_name, entity_id, source_app, source_summary,
          source_ts, confidence, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.text,
      input.rawText ?? input.text,
      input.due ?? null,
      input.dueAt ?? null,
      input.entityName ?? null,
      input.entityId ?? null,
      input.sourceApp ?? null,
      input.sourceSummary ?? null,
      input.sourceTs ?? null,
      input.confidence ?? 0.8,
      input.status ?? 'open',
      input.createdAt ?? Date.now()
    )
  return Number(info.lastInsertRowid)
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
  db.prepare('INSERT INTO entity_facts (entity_id, fact, source_session_id) VALUES (?, ?, ?)').run(
    input.entityId,
    input.fact,
    input.sourceSessionId ?? null
  )
}
