// Capture v2: vision-learned per-app layout. On first encounter of an app, ask
// the vision model which part of the screenshot is the MAIN content (excluding
// sidebars/nav/toolbars) and classify the app + default category. Cache it
// (per app, daily TTL). On the hot path we crop the screenshot to that region
// before OCR — so WhatsApp/Gmail/Slack capture the open conversation/message,
// not the whole chrome. No AX needed, so it survives Secure Keyboard Entry.

import path from 'path';
import { getDB } from '../database';
import { llm } from '../llm';

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface AppLayout {
  region: Region | null;
  appType: string;
  category: string;
  learnedAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000; // re-learn daily (layouts drift)

let ready = false;
function ensureTable(): void {
  if (ready) return;
  getDB().exec(
    `CREATE TABLE IF NOT EXISTS app_layouts (
       app TEXT PRIMARY KEY,
       region TEXT,
       app_type TEXT,
       category TEXT,
       learned_at INTEGER NOT NULL DEFAULT 0
     )`
  );
  ready = true;
}

/** Cached layout for an app, or null if absent/stale (caller should re-learn). */
export function getLayout(app: string, nowMs: number): AppLayout | null {
  ensureTable();
  const row = getDB()
    .prepare('SELECT region, app_type AS appType, category, learned_at AS learnedAt FROM app_layouts WHERE app = ?')
    .get(app) as { region: string | null; appType: string; category: string; learnedAt: number } | undefined;
  if (!row) return null;
  if (nowMs - row.learnedAt > TTL_MS) return null; // stale → re-learn
  return {
    region: row.region ? (JSON.parse(row.region) as Region) : null,
    appType: row.appType,
    category: row.category,
    learnedAt: row.learnedAt,
  };
}

/** Force re-learn (used by the menu-bar "recalibrate"). */
export function clearLayout(app?: string): void {
  ensureTable();
  if (app) getDB().prepare('DELETE FROM app_layouts WHERE app = ?').run(app);
  else getDB().prepare('DELETE FROM app_layouts').run();
}

const LAYOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hasMainRegion: { type: 'boolean' },
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
    appType: { type: 'string' },
    category: { type: 'string', enum: ['work', 'communication', 'consumption', 'other'] },
  },
  required: ['hasMainRegion', 'x', 'y', 'w', 'h', 'appType', 'category'],
} as const;

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Learn (and cache) an app's main-content region + type via the vision model. */
export async function learnLayout(app: string, imagePath: string, nowMs: number): Promise<AppLayout | null> {
  ensureTable();
  const prompt = `This is a screenshot of the app "${app}". Identify the MAIN content area the user is actively working in — the OPEN conversation, the document/editor, the article being read — and EXCLUDE left/right sidebars, navigation rails, toolbars, chat/conversation lists, and suggestion panels.

Reply JSON only:
{"hasMainRegion": <true if a clear main area is distinct from the chrome>, "x": <left as fraction 0-1>, "y": <top as fraction 0-1>, "w": <width fraction>, "h": <height fraction>, "appType": "<messaging|email|browser|editor|terminal|social|other>", "category": "work|communication|consumption|other"}`;

  try {
    const resp = await llm.chat(prompt, [imagePath], 120_000, 300, {
      responseFormat: { type: 'json_schema', json_schema: { name: 'layout', schema: LAYOUT_SCHEMA, strict: true } },
      temperature: 0.2,
      disableThinking: true,
    });
    const s = resp.indexOf('{');
    const e = resp.lastIndexOf('}');
    const p = JSON.parse(s >= 0 && e > s ? resp.slice(s, e + 1) : '{}');
    let region: Region | null = null;
    if (p.hasMainRegion) {
      const r = { x: clamp01(p.x), y: clamp01(p.y), w: clamp01(p.w), h: clamp01(p.h) };
      // Ignore a region that's basically the whole screen (no useful crop).
      if (r.w >= 0.2 && r.h >= 0.2 && !(r.x <= 0.02 && r.y <= 0.02 && r.w >= 0.97 && r.h >= 0.97)) region = r;
    }
    getDB()
      .prepare(
        `INSERT INTO app_layouts (app, region, app_type, category, learned_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(app) DO UPDATE SET region = excluded.region, app_type = excluded.app_type,
           category = excluded.category, learned_at = excluded.learned_at`
      )
      .run(app, region ? JSON.stringify(region) : null, p.appType ?? 'other', p.category ?? 'work', nowMs);
    return { region, appType: p.appType ?? 'other', category: p.category ?? 'work', learnedAt: nowMs };
  } catch (err) {
    console.error('[layout] learn failed:', err);
    return null;
  }
}

/** Crop a screenshot to a fractional region; returns a new file path or null. */
export async function cropToRegion(imagePath: string, region: Region): Promise<string | null> {
  try {
    // sharp is a native dep already used elsewhere; lazy-require to keep startup light.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = require('sharp');
    const meta = await sharp(imagePath).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return null;
    const left = Math.max(0, Math.round(region.x * W));
    const top = Math.max(0, Math.round(region.y * H));
    const width = Math.min(W - left, Math.round(region.w * W));
    const height = Math.min(H - top, Math.round(region.h * H));
    if (width < 80 || height < 80) return null;
    const out = imagePath.replace(/\.png$/i, '-crop.png');
    await sharp(imagePath).extract({ left, top, width, height }).toFile(out);
    return out;
  } catch (err) {
    console.error('[layout] crop failed:', err);
    return null;
  }
}
