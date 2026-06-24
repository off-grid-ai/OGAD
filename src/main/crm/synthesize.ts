// The intelligence layer: synthesize an entity's many redundant observations
// into a short narrative ("you did X, then Y, and Z happened") — instead of a
// raw listicle. Stored in entities.summary and shown at the top of the record.

import { getDB } from '../database';
import { migrateCrm } from './schema';
import { llm } from '../llm';

export async function summarizeEntity(entityId: number): Promise<string> {
  migrateCrm();
  const db = getDB();
  const ent = db.prepare('SELECT name, type FROM entities WHERE id = ?').get(entityId) as
    | { name: string; type: string }
    | undefined;
  if (!ent) return '';

  const obs = db
    .prepare(
      `SELECT o.summary AS summary, COALESCE(o.surface, o.surface_app, '') AS surface
       FROM observations o
       JOIN observation_entities oe ON oe.observation_id = o.id
       WHERE oe.entity_id = ? ORDER BY o.ts DESC LIMIT 40`
    )
    .all(entityId) as { summary: string; surface: string }[];
  if (obs.length === 0) return '';

  const notes = obs.map((o) => `- ${o.summary}`).join('\n');
  const prompt = `Synthesize what has been going on with "${ent.name}" (${ent.type}) into 2-4 sentences of narrative. Combine the redundant/overlapping notes below into a coherent story: what was worked on, what was done, and what happened/resulted. Be specific and concrete (mention real names, files, outcomes). No bullet points, no preamble, no headings — just the prose.

Activity notes (most recent first):
${notes}`;

  try {
    const text = await llm.chat(prompt, [], 120_000, 400, { temperature: 0.4, disableThinking: true });
    const summary = text.trim();
    if (summary) {
      db.prepare("UPDATE entities SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(summary, entityId);
    }
    return summary;
  } catch (e) {
    console.error('[CRM synthesize] failed:', e);
    return '';
  }
}
