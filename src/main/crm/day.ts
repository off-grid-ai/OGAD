// Day / productivity view: turn the stream of observations into time BLOCKS —
// contiguous activity on a surface — so the calendar can answer "what did I do
// between 7 and 8pm?". Blocks merge consecutive observations on the same surface
// within a short gap. Times use epoch seconds (UTC-safe via strftime) so the
// renderer can place them on a local-time grid.

import { getDB } from '../database';
import { migrateCrm } from './schema';
import { llm } from '../llm';

export interface ActivityBlock {
  startSec: number;
  endSec: number;
  surface: string;
  /** Distinct observation summaries within the block (what you did). */
  summaries: string[];
  entities: { id: number; name: string; type: string }[];
  count: number;
}

const GAP_SEC = 15 * 60; // merge same-surface activity within 15 min

export function getDayActivity(startSec: number, endSec: number): ActivityBlock[] {
  migrateCrm();
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT o.id AS id, o.summary AS summary,
              COALESCE(o.surface, o.surface_app, 'Unknown') AS surface,
              CAST(strftime('%s', o.ts) AS INTEGER) AS sec
       FROM observations o
       WHERE CAST(strftime('%s', o.ts) AS INTEGER) BETWEEN ? AND ?
         -- Exclude observations that are exclusively about archived (hidden) entities.
         AND NOT (
           EXISTS (SELECT 1 FROM observation_entities oe JOIN entities e ON e.id = oe.entity_id
                   WHERE oe.observation_id = o.id AND e.hidden = 1)
           AND NOT EXISTS (SELECT 1 FROM observation_entities oe2 JOIN entities e2 ON e2.id = oe2.entity_id
                           WHERE oe2.observation_id = o.id AND e2.hidden = 0)
         )
       ORDER BY sec ASC`
    )
    .all(startSec, endSec) as { id: number; summary: string; surface: string; sec: number }[];

  if (rows.length === 0) return [];

  const entStmt = db.prepare(
    `SELECT e.id, e.name, e.type FROM entities e
     JOIN observation_entities oe ON oe.entity_id = e.id
     WHERE oe.observation_id = ? AND e.hidden = 0`
  );

  type Acc = ActivityBlock & { _obsIds: number[]; _ents: Map<number, { id: number; name: string; type: string }> };
  const blocks: Acc[] = [];

  for (const r of rows) {
    let block = blocks[blocks.length - 1];
    if (!block || block.surface !== r.surface || r.sec - block.endSec > GAP_SEC) {
      block = {
        startSec: r.sec,
        endSec: r.sec,
        surface: r.surface,
        summaries: [],
        entities: [],
        count: 0,
        _obsIds: [],
        _ents: new Map(),
      };
      blocks.push(block);
    }
    block.endSec = r.sec;
    block.count += 1;
    block._obsIds.push(r.id);
    if (r.summary && !block.summaries.includes(r.summary)) block.summaries.push(r.summary);
    for (const e of entStmt.all(r.id) as { id: number; name: string; type: string }[]) {
      block._ents.set(e.id, e);
    }
  }

  return blocks.map((b) => ({
    startSec: b.startSec,
    endSec: b.endSec,
    surface: b.surface,
    summaries: b.summaries.slice(0, 6),
    entities: Array.from(b._ents.values()).slice(0, 8),
    count: b.count,
  }));
}

// Journals are expensive (LLM) and we want them to SURVIVE restarts + show
// instantly, so we persist one per day keyed by the day's start-second.
function ensureJournalTable(): void {
  getDB().exec(
    `CREATE TABLE IF NOT EXISTS day_journals (
       day_key INTEGER PRIMARY KEY,
       text TEXT NOT NULL,
       updated_at INTEGER NOT NULL DEFAULT 0
     )`
  );
}

/** The last-saved journal for a day, instantly (no LLM). Empty string if none. */
export function getStoredDayJournal(startSec: number): string {
  migrateCrm();
  ensureJournalTable();
  const row = getDB().prepare('SELECT text FROM day_journals WHERE day_key = ?').get(startSec) as
    | { text: string }
    | undefined;
  return row?.text ?? '';
}

/** A short first-person journal entry summarizing the day from its activity. */
export async function getDayJournal(startSec: number, endSec: number): Promise<string> {
  ensureJournalTable();
  const blocks = getDayActivity(startSec, endSec);
  // No activity → keep whatever we already had (don't wipe a real journal).
  if (blocks.length === 0) return getStoredDayJournal(startSec);

  const fmt = (s: number): string =>
    new Date(s * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const notes = blocks
    .map((b) => {
      const who = b.entities[0]?.name ?? b.surface;
      const what = b.summaries[0] ?? `${b.count} activities`;
      return `- ${fmt(b.startSec)} (${who}, ${b.surface}): ${what}`;
    })
    .join('\n');

  const prompt = `Write a first-person journal entry (past tense) summarizing my day from these activity notes. Be detailed and reflective — cover what I worked on and the outcomes, who I communicated with, and what I read/consumed. Be specific (name the projects, people, files, results).

Break it into 2-4 SHORT paragraphs, each covering one theme (e.g. one for the dev work, one for communication, one for what I consumed). Separate paragraphs with a blank line. HARD LIMIT: under 300 words total. No bullet points, no headings, no preamble — just the diary text.

Activity notes:
${notes}`;

  try {
    const text = (await llm.chat(prompt, [], 120_000, 600, { temperature: 0.45, disableThinking: true })).trim();
    if (text) {
      getDB()
        .prepare(
          `INSERT INTO day_journals (day_key, text, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(day_key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`
        )
        .run(startSec, text, Date.now());
    }
    // If generation came back empty, keep the previously stored journal.
    return text || getStoredDayJournal(startSec);
  } catch (e) {
    console.error('[CRM day journal] failed:', e);
    return getStoredDayJournal(startSec);
  }
}
