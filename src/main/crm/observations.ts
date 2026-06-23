// Record an observation: the distilled "what happened" unit. Resolves its
// mentions to entities (the spine), links them, and optionally attaches the raw
// frame(s) it was distilled from. This is what the capture->extract->gate
// pipeline calls once something passes the engagement + salience filter.

import { BrowserWindow } from 'electron';
import { getDB } from '../database';
import { migrateCrm } from './schema';
import { resolveEntity, findEntityIdByName, setEntityParent, type Mention } from './resolve';

export interface FrameInput {
  surface?: string;
  app?: string;
  windowTitle?: string;
  url?: string;
  imagePath?: string;
  text?: string;
  source?: string;
  ts?: string;
}

export interface ObservationInput {
  summary: string;
  surface?: string;
  surfaceApp?: string;
  url?: string;
  category?: string;
  sourceSessionId?: string;
  /** Behavioral signal 0..1 (dwell + input). */
  engagement?: number;
  /** Content signal 0..1 (LLM "is this signal?" judgement). */
  salience?: number;
  ts?: string;
  mentions: Mention[];
  frames?: FrameInput[];
}

/**
 * One-time backfill: turn already-captured memories into observations so the
 * CRM records have real history immediately (each memory -> observation on its
 * source app, linked to that session's entities). No-op once observations exist.
 */
export function backfillFromMemories(): number {
  migrateCrm();
  const db = getDB();
  const existing = db.prepare('SELECT COUNT(*) AS c FROM observations').get() as { c: number };
  if (existing.c > 0) return 0;

  const mems = db
    .prepare(
      `SELECT id, content, source_app, session_id, created_at
       FROM memories WHERE content IS NOT NULL AND content != '' ORDER BY created_at ASC`
    )
    .all() as { id: number; content: string; source_app: string | null; session_id: string | null; created_at: string }[];

  const entStmt = db.prepare(
    `SELECT e.name, e.type FROM entities e
     JOIN entity_sessions es ON es.entity_id = e.id WHERE es.session_id = ?`
  );

  let made = 0;
  for (const m of mems) {
    const ents = m.session_id ? (entStmt.all(m.session_id) as { name: string; type: string }[]) : [];
    recordObservation({
      summary: m.content,
      surface: m.source_app ?? undefined,
      surfaceApp: m.source_app ?? undefined,
      sourceSessionId: m.session_id ?? undefined,
      engagement: 0.5,
      salience: 0.5,
      ts: m.created_at,
      mentions: ents.map((e) => ({ name: e.name, type: e.type })),
    });
    made++;
  }
  return made;
}

export function recordObservation(input: ObservationInput): { observationId: number; entityIds: number[] } {
  migrateCrm();
  const db = getDB();

  let observationId = 0;
  const entityIds: number[] = [];

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO observations (summary, surface, surface_app, url, category, source_session_id, engagement, salience, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
      )
      .run(
        input.summary,
        input.surface ?? null,
        input.surfaceApp ?? null,
        input.url ?? null,
        input.category ?? 'work',
        input.sourceSessionId ?? null,
        input.engagement ?? 0,
        input.salience ?? 0,
        input.ts ?? null
      );
    observationId = Number(info.lastInsertRowid);

    // Resolve + link entities (the spine).
    const linkStmt = db.prepare(
      'INSERT OR IGNORE INTO observation_entities (observation_id, entity_id, role) VALUES (?, ?, ?)'
    );
    for (const m of input.mentions) {
      const { entityId } = resolveEntity(m);
      if (entityId) {
        linkStmt.run(observationId, entityId, null);
        entityIds.push(entityId);
        // Component-of-a-known-project: parent under an EXISTING entity only
        // (never auto-create the parent) so hierarchy forms at creation time.
        if (m.partOf && m.partOf.trim()) {
          const parentId = findEntityIdByName(m.partOf);
          if (parentId && parentId !== entityId) setEntityParent(entityId, parentId);
        }
      }
    }

    // Attach raw frames (evidence) if provided.
    if (input.frames?.length) {
      const frameStmt = db.prepare(
        `INSERT INTO frames (ts, surface, app, window_title, url, image_path, text, source)
         VALUES (COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?, ?)`
      );
      const linkFrame = db.prepare('INSERT OR IGNORE INTO observation_frames (observation_id, frame_id) VALUES (?, ?)');
      for (const f of input.frames) {
        const fi = frameStmt.run(
          f.ts ?? null,
          f.surface ?? input.surface ?? null,
          f.app ?? input.surfaceApp ?? null,
          f.windowTitle ?? null,
          f.url ?? input.url ?? null,
          f.imagePath ?? null,
          f.text ?? null,
          f.source ?? null
        );
        linkFrame.run(observationId, Number(fi.lastInsertRowid));
      }
    }
  });
  tx();

  // Notify open windows so Day / Entities refresh live.
  try {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('crm:changed'));
  } catch {
    /* ignore */
  }

  return { observationId, entityIds: [...new Set(entityIds)] };
}
