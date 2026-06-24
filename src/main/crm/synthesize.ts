// The intelligence layer: synthesize an entity's many redundant observations
// into a short narrative ("you did X, then Y, and Z happened") — instead of a
// raw listicle. Stored in entities.summary and shown at the top of the record.
//
// Cross-source: the narrative fuses on-screen activity (observations) with what
// the secretary has DONE/proposed for this entity (approvals via connectors) and
// any scheduled meetings that involve it (calendar) — so the summary reads across
// capture + connectors, not just raw observations.

import { getDB } from '../database';
import { migrateCrm } from './schema';
import { llm } from '../llm';

function fmtDay(ts: number | null | undefined): string {
  if (!ts) return '';
  // approvals store ms; calendar stores seconds — normalize either to a date.
  const ms = ts > 1e12 ? ts : ts * 1000;
  try { return new Date(ms).toISOString().slice(0, 10); } catch { return ''; }
}

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

  // Connector actions: what the secretary has proposed/taken for this entity.
  const actions = db
    .prepare(
      `SELECT title, status, connector, created_at
       FROM approvals WHERE entity_name = ? ORDER BY created_at DESC LIMIT 10`
    )
    .all(ent.name) as { title: string; status: string; connector: string | null; created_at: number }[];

  // Calendar: meetings whose title or attendees mention this entity.
  const like = `%${ent.name}%`;
  const events = db
    .prepare(
      `SELECT title, starts_at, attendees
       FROM upcoming_events WHERE title LIKE ? OR attendees LIKE ?
       ORDER BY starts_at DESC LIMIT 8`
    )
    .all(like, like) as { title: string; starts_at: number | null; attendees: string | null }[];

  // Nothing from any source → no summary.
  if (obs.length === 0 && actions.length === 0 && events.length === 0) return '';

  const sections: string[] = [];
  if (obs.length) {
    sections.push(`On-screen activity (most recent first):\n${obs.map((o) => `- ${o.summary}`).join('\n')}`);
  }
  if (actions.length) {
    sections.push(
      `Actions Off Grid handled for this ${ent.type} (via connectors):\n` +
        actions
          .map((a) => `- ${a.title}${a.connector ? ` [${a.connector}]` : ''} — ${a.status}${fmtDay(a.created_at) ? ` (${fmtDay(a.created_at)})` : ''}`)
          .join('\n')
    );
  }
  if (events.length) {
    sections.push(
      `Meetings involving them:\n` +
        events
          .map((e) => `- ${e.title}${fmtDay(e.starts_at) ? ` (${fmtDay(e.starts_at)})` : ''}${e.attendees ? ` with ${e.attendees}` : ''}`)
          .join('\n')
    );
  }

  const prompt = `Synthesize what has been going on with "${ent.name}" (${ent.type}) into 2-4 sentences of narrative. Weave the sources below — on-screen activity, actions Off Grid handled, and meetings — into ONE coherent story: what was worked on, what was done (including what Off Grid did on the user's behalf), and what's coming up. Be specific and concrete (mention real names, files, outcomes, dates). No bullet points, no preamble, no headings — just the prose.

${sections.join('\n\n')}`;

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
