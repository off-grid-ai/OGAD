// Secretary learning loop. When the user rejects a proposal they can say WHY.
// Raw reasons are stored but NEVER injected into the proposer prompt — instead an
// hourly, deliberately-conservative LLM pass folds genuinely-durable preferences
// into a short "learned preferences" doc. That doc (and only that doc) is what the
// proposer reads, and it's shown to the user in Settings. This keeps the system
// adapting "live" without one-off reasons making it behave strangely.

import { getDB } from '../database';
import { llm } from '../llm';

function ensure(): void {
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS secretary_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      approval_id INTEGER,
      title TEXT,
      connector TEXT,
      tool TEXT,
      entity_name TEXT,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      processed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS secretary_prefs (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      doc TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO secretary_prefs (id, doc, updated_at) VALUES (1, '', 0);
  `);
}

export interface FeedbackInput {
  approvalId?: number;
  title?: string | null;
  connector?: string | null;
  tool?: string | null;
  entityName?: string | null;
  reason: string;
}

/** Store a raw rejection reason. Never read directly into a prompt — only distilled. */
export function recordFeedback(f: FeedbackInput): void {
  ensure();
  const reason = (f.reason || '').trim();
  if (!reason) return;
  getDB()
    .prepare(
      `INSERT INTO secretary_feedback (approval_id, title, connector, tool, entity_name, reason, created_at, processed)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(f.approvalId ?? null, f.title ?? null, f.connector ?? null, f.tool ?? null, f.entityName ?? null, reason, Date.now());
}

export interface Preferences { doc: string; updatedAt: number; pendingFeedback: number }

export function getPreferences(): Preferences {
  ensure();
  const row = getDB().prepare('SELECT doc, updated_at AS updatedAt FROM secretary_prefs WHERE id = 1').get() as
    | { doc: string; updatedAt: number }
    | undefined;
  const pending = (getDB().prepare('SELECT COUNT(*) AS n FROM secretary_feedback WHERE processed = 0').get() as { n: number }).n;
  return { doc: row?.doc ?? '', updatedAt: row?.updatedAt ?? 0, pendingFeedback: pending };
}

/** The text injected into the proposer prompt (empty string if nothing learned). */
export function getPreferenceDoc(): string {
  return getPreferences().doc;
}

/** Manual override from Settings (e.g. clear, or hand-edit). */
export function setPreferences(doc: string): void {
  ensure();
  getDB().prepare('UPDATE secretary_prefs SET doc = ?, updated_at = ? WHERE id = 1').run(doc.slice(0, MAX_DOC), Date.now());
}

const MAX_DOC = 1800; // keep the injected block small

function extractJson(s: string): string {
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  return a >= 0 && b > a ? s.slice(a, b + 1) : s;
}

/**
 * Hourly: fold new rejection reasons into the standing preferences. The model
 * decides what (if anything) is a real, general, durable preference — conservative
 * by design, so a one-off gripe never warps future behavior. Returns the doc.
 */
export async function distillPreferences(): Promise<{ updated: boolean; doc: string }> {
  ensure();
  const db = getDB();
  const fb = db
    .prepare(
      `SELECT id, title, connector, tool, entity_name, reason
       FROM secretary_feedback WHERE processed = 0 ORDER BY created_at ASC LIMIT 40`
    )
    .all() as { id: number; title: string | null; connector: string | null; tool: string | null; entity_name: string | null; reason: string }[];
  const current = getPreferenceDoc();
  if (!fb.length) return { updated: false, doc: current };

  const feedbackText = fb
    .map((f) => `- Rejected "${f.title ?? '(untitled)'}"${f.connector || f.tool ? ` [${[f.connector, f.tool].filter(Boolean).join('/')}]` : ''}: ${f.reason}`)
    .join('\n');

  const prompt = `You maintain a SHORT list of standing preferences for a proactive personal-assistant that proposes actions (email drafts, CRM notes, tasks, calendar events, etc.) for the user to approve. The user rejected some proposals and gave reasons. Decide whether to update the preferences.

Be VERY conservative. ONLY add or change a rule when a reason expresses a CLEAR, GENERAL, durable preference that should change future behavior (e.g. "don't draft replies on threads I'm only cc'd on", "don't log routine status emails to the CRM", "Nowshad handles support — don't propose those for me"). IGNORE one-offs, vague complaints, contradictions, anything ambiguous, and anything that would make the assistant stop being useful or behave oddly. Merge/refine related rules and keep the list SHORT. If none of the new reasons is a real standing preference, return the current list UNCHANGED.

CURRENT PREFERENCES:
${current || '(none yet)'}

NEW REJECTIONS (the reason follows the colon):
${feedbackText}

Return JSON only — the FULL updated list, most important first, each rule one short imperative line, max 8 rules:
{"preferences": ["...", "..."]}`;

  let doc = current;
  try {
    const resp = await llm.chat(prompt, [], 120000, 700, { disableThinking: true, temperature: 0.2 });
    const parsed = JSON.parse(extractJson(resp)) as { preferences?: unknown };
    if (Array.isArray(parsed.preferences)) {
      doc = parsed.preferences
        .map((r) => `- ${String(r).trim().replace(/^[-•]\s*/, '')}`)
        .filter((l) => l.length > 3)
        .slice(0, 8)
        .join('\n')
        .slice(0, MAX_DOC);
    }
  } catch (e) {
    // Leave the doc unchanged and DON'T mark processed, so we retry next hour.
    console.error('[secretary] preference distill failed', e);
    return { updated: false, doc: current };
  }

  setPreferences(doc);
  const ids = fb.map((f) => f.id);
  db.prepare(`UPDATE secretary_feedback SET processed = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  return { updated: true, doc };
}
