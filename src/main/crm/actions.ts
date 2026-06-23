// Action items — the first step from "see & remember" to "act". When the user
// reads/writes communication (an email, a Slack thread, a DM) that contains
// asks/commitments/follow-ups, we extract concrete TASKS the user needs to do
// and surface them as a reviewable list, tied to the project/person they're
// about. NEVER auto-acted — the user checks them off or dismisses them.

import { BrowserWindow } from 'electron';
import { getDB } from '../database';
import { llm } from '../llm';

let ready = false;
function ensure(): void {
  if (ready) return;
  getDB().exec(
    `CREATE TABLE IF NOT EXISTS action_items (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       text TEXT NOT NULL,
       due TEXT,                          -- free-text due/when, if stated ("by Friday")
       entity_name TEXT,                  -- the project/person it's about (for grouping)
       source_app TEXT,
       source_summary TEXT,
       source_ts INTEGER,
       confidence REAL NOT NULL DEFAULT 0.6,
       status TEXT NOT NULL DEFAULT 'open', -- open | done | dismissed
       created_at INTEGER NOT NULL DEFAULT 0,
       dedup_key TEXT UNIQUE
     );
     CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(status);`
  );
  ready = true;
}

export interface ActionItem {
  id: number;
  text: string;
  due: string | null;
  entity_name: string | null;
  source_app: string | null;
  source_summary: string | null;
  source_ts: number | null;
  confidence: number;
  status: string;
  created_at: number;
}

const ACTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          owner: { type: 'string', enum: ['me', 'someone_else', 'unclear'] },
          due: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['text', 'owner', 'due', 'confidence'],
      },
    },
  },
  required: ['items'],
} as const;

const ACTIONS_RF = { type: 'json_schema', json_schema: { name: 'actions', schema: ACTIONS_SCHEMA, strict: true } };

function extractJson(s: string): string {
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  return a >= 0 && b > a ? s.slice(a, b + 1) : '{}';
}

function emitChanged(): void {
  try {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('crm:changed'));
  } catch {
    /* ignore */
  }
}

/**
 * Pull concrete action items the USER needs to do out of captured comms text.
 * Stores new ones (deduped). Returns count of NEW items added.
 */
export async function extractActionItems(params: {
  material: string;
  app: string;
  summary: string;
  entityName?: string;
  ts: number; // epoch seconds of the source moment
}): Promise<number> {
  ensure();
  const material = (params.material || '').trim();
  if (material.length < 40) return 0;

  const prompt = `From the captured screen text below, extract ONLY genuine ACTION ITEMS that I (the user) have personally committed to, or been clearly asked, to do — a real task with a concrete next step I must take.

This is the hard part — most text is NOT a to-do. Be strict:
- A real action item: an explicit ask/commitment directed at ME with a clear action. Good: "Send the deck to Priya by Friday", "Review the audio PR", "Reply to Ali about pricing".
- NOT an action item: things merely discussed, ideas, opinions, observations, status updates, decisions, something SOMEONE ELSE will do, things already done, or hypotheticals ("we could maybe…", "it'd be good to…"). When in doubt, DO NOT extract. If none, return {"items": []}.
- "owner": "me" ONLY if it is clearly MY task; "someone_else" if it's another person's; "unclear" if you can't tell. Only "me" items are kept — do not guess "me".
- "due": copy any stated deadline verbatim ("by Friday", "EOD"), else "".
- "confidence": 0.0–1.0 — how sure you are this is a real, committed task of MINE. Be strict; if it reads like discussion rather than a commitment, score low.
- Keep each "text" short and imperative (start with a verb). Max ~12 words.

Captured text (app: ${params.app}):
"""
${material.slice(0, 4000)}
"""

Reply JSON only: {"items": [{"text": "...", "owner": "me|someone_else|unclear", "due": "", "confidence": 0.0}]}`;

  let parsed: { items?: { text: string; owner: string; due?: string; confidence?: number }[] };
  try {
    const resp = await llm.chat(prompt, [], 120_000, 400, { responseFormat: ACTIONS_RF, temperature: 0.2, disableThinking: true });
    parsed = JSON.parse(extractJson(resp));
  } catch (e) {
    console.error('[actions] extract failed:', e);
    return 0;
  }

  let added = 0;
  const ins = getDB().prepare(
    `INSERT OR IGNORE INTO action_items (text, due, entity_name, source_app, source_summary, source_ts, confidence, status, created_at, dedup_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  );
  for (const it of parsed.items ?? []) {
    const text = (it?.text || '').trim();
    if (text.length < 4) continue;
    if (it.owner !== 'me') continue; // keep ONLY clearly-mine tasks (drop someone_else + unclear)
    if ((it.confidence ?? 0) < 0.6) continue; // strict: discussion scores low, real commitments high
    const key = `${params.app}:${text}`.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
    const info = ins.run(
      text,
      it.due || null,
      params.entityName || null,
      params.app,
      params.summary,
      params.ts,
      it.confidence ?? 0.6,
      Date.now(),
      key
    );
    if (info.changes > 0) {
      added += 1;
      try {
        const actionId = Number(info.lastInsertRowid);
        BrowserWindow.getAllWindows().forEach((w) =>
          w.webContents.send('notification:new-action', {
            actionId,
            text,
            due: it.due || null,
            entityName: params.entityName || null,
            sourceApp: params.app,
          })
        );
      } catch {
        /* ignore */
      }
    }
  }
  if (added > 0) emitChanged();
  return added;
}

export function listActionItems(): ActionItem[] {
  ensure();
  return getDB()
    .prepare(
      `SELECT id, text, due, entity_name, source_app, source_summary, source_ts, confidence, status, created_at
       FROM action_items
       ORDER BY (status = 'open') DESC, COALESCE(source_ts, created_at) DESC`
    )
    .all() as ActionItem[];
}

export function setActionItemStatus(id: number, status: 'open' | 'done' | 'dismissed'): void {
  ensure();
  getDB().prepare('UPDATE action_items SET status = ? WHERE id = ?').run(status, id);
  emitChanged();
}
