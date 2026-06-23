// The CRM entity record reader: assemble everything the entity page shows.
// Entity -> App (surface) -> frames below. Returns the chronological observation
// feed, a per-surface breakdown, aliases, related entities (graph), and frames
// on demand. Search is FTS over observations, optionally scoped to an entity.

import { getDB } from '../database';
import { migrateCrm } from './schema';

export interface EntityRecord {
  entity: { id: number; name: string; type: string; summary: string | null; imagePath: string | null; updatedAt: string };
  aliases: { id: number; kind: string; value: string; source: string }[];
  surfaces: { surface: string; count: number; lastTs: string }[];
  related: { id: number; name: string; type: string; weight: number }[];
  observations: ObservationRow[];
}

export interface ObservationRow {
  id: number;
  summary: string;
  surface: string | null;
  app: string | null;
  url: string | null;
  ts: string;
  frameCount: number;
}

export function getEntityRecord(entityId: number, opts: { surface?: string; limit?: number } = {}): EntityRecord | null {
  migrateCrm();
  const db = getDB();
  const entity = db
    .prepare('SELECT id, name, type, summary, image_path, updated_at FROM entities WHERE id = ?')
    .get(entityId) as
    | { id: number; name: string; type: string; summary: string | null; image_path: string | null; updated_at: string }
    | undefined;
  if (!entity) return null;

  const aliases = db
    .prepare('SELECT id, kind, value, source FROM entity_aliases WHERE entity_id = ? ORDER BY source DESC, kind')
    .all(entityId) as { id: number; kind: string; value: string; source: string }[];

  // Per-surface breakdown (Entity -> App).
  const surfaces = db
    .prepare(
      `SELECT COALESCE(o.surface, o.surface_app, 'Unknown') AS surface, COUNT(*) AS count, MAX(o.ts) AS lastTs
       FROM observations o
       JOIN observation_entities oe ON oe.observation_id = o.id
       WHERE oe.entity_id = ?
       GROUP BY surface ORDER BY count DESC`
    )
    .all(entityId) as { surface: string; count: number; lastTs: string }[];

  // Related entities via the graph edges (either direction).
  const related = db
    .prepare(
      `SELECT e.id, e.name, e.type, ed.weight FROM entity_edges ed
       JOIN entities e ON e.id = CASE WHEN ed.source_entity_id = ? THEN ed.target_entity_id ELSE ed.source_entity_id END
       WHERE ed.source_entity_id = ? OR ed.target_entity_id = ?
       ORDER BY ed.weight DESC LIMIT 12`
    )
    .all(entityId, entityId, entityId) as { id: number; name: string; type: string; weight: number }[];

  // Chronological observation feed (optionally scoped to a surface).
  const params: unknown[] = [entityId];
  let where = 'oe.entity_id = ?';
  if (opts.surface) {
    where += " AND COALESCE(o.surface, o.surface_app, 'Unknown') = ?";
    params.push(opts.surface);
  }
  params.push(opts.limit ?? 100);
  const observations = db
    .prepare(
      `SELECT o.id, o.summary, o.surface, o.surface_app AS app, o.url, o.ts,
              (SELECT COUNT(*) FROM observation_frames f WHERE f.observation_id = o.id) AS frameCount
       FROM observations o
       JOIN observation_entities oe ON oe.observation_id = o.id
       WHERE ${where}
       ORDER BY o.ts DESC LIMIT ?`
    )
    .all(...params) as ObservationRow[];

  return {
    entity: {
      id: entity.id,
      name: entity.name,
      type: entity.type,
      summary: entity.summary,
      imagePath: entity.image_path,
      updatedAt: entity.updated_at,
    },
    aliases,
    surfaces,
    related,
    observations,
  };
}

/** Frames beneath an observation (the raw evidence). */
export function getObservationFrames(observationId: number): {
  id: number;
  ts: string;
  surface: string | null;
  app: string | null;
  windowTitle: string | null;
  url: string | null;
  imagePath: string | null;
  text: string | null;
}[] {
  migrateCrm();
  return getDB()
    .prepare(
      `SELECT fr.id, fr.ts, fr.surface, fr.app, fr.window_title AS windowTitle, fr.url, fr.image_path AS imagePath, fr.text
       FROM frames fr
       JOIN observation_frames of2 ON of2.frame_id = fr.id
       WHERE of2.observation_id = ? ORDER BY fr.ts ASC`
    )
    .all(observationId) as any[];
}

/** FTS over observations, optionally scoped to an entity. */
export function searchObservations(query: string, entityId?: number): ObservationRow[] {
  migrateCrm();
  const db = getDB();
  const q = query.trim();
  if (!q) return [];
  const params: unknown[] = [q];
  let join = '';
  let cond = '';
  if (entityId) {
    join = 'JOIN observation_entities oe ON oe.observation_id = o.id';
    cond = 'AND oe.entity_id = ?';
    params.push(entityId);
  }
  return db
    .prepare(
      `SELECT o.id, o.summary, o.surface, o.surface_app AS app, o.url, o.ts,
              (SELECT COUNT(*) FROM observation_frames f WHERE f.observation_id = o.id) AS frameCount
       FROM observation_fts fts
       JOIN observations o ON o.id = fts.rowid
       ${join}
       WHERE observation_fts MATCH ? ${cond}
       ORDER BY o.ts DESC LIMIT 100`
    )
    .all(...params) as ObservationRow[];
}

/** Lightweight entity list for the CRM index (counts + parent + latest line). */
export function listEntitiesWithActivity(): {
  id: number;
  name: string;
  type: string;
  parentId: number | null;
  hidden: number;
  imagePath: string | null;
  observationCount: number;
  lastTs: string | null;
  latestSummary: string | null;
}[] {
  migrateCrm();
  return getDB()
    .prepare(
      `SELECT e.id, e.name, e.type, e.parent_id AS parentId, e.hidden AS hidden, e.image_path AS imagePath,
              COUNT(oe.observation_id) AS observationCount,
              COUNT(DISTINCT substr(o.ts, 1, 10)) AS distinctDays,
              MAX(o.ts) AS lastTs,
              (SELECT o2.summary FROM observation_entities oe2
                 JOIN observations o2 ON o2.id = oe2.observation_id
                 WHERE oe2.entity_id = e.id ORDER BY o2.ts DESC LIMIT 1) AS latestSummary
       FROM entities e
       LEFT JOIN observation_entities oe ON oe.entity_id = e.id
       LEFT JOIN observations o ON o.id = oe.observation_id
       GROUP BY e.id ORDER BY lastTs DESC NULLS LAST, e.name ASC`
    )
    .all() as {
    id: number;
    name: string;
    type: string;
    parentId: number | null;
    hidden: number;
    imagePath: string | null;
    observationCount: number;
    distinctDays: number;
    lastTs: string | null;
    latestSummary: string | null;
  }[];
}
