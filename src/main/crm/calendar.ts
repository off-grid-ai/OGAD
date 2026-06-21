// Calendar via CAPTURE, not an OAuth client (the Off Grid "stay offline" call).
// When the user is looking at a calendar (Google Calendar / Calendar.app /
// Fantastical) or an email/invite that contains an event, we extract the
// upcoming events from the on-screen text with the local LLM and store them.
// This is the future-event source that powers the prospective "Ahead" view —
// nothing leaves the device, no API client to register.

import { getDB } from '../database';
import { llm } from '../llm';

let ready = false;
function ensure(): void {
  if (ready) return;
  getDB().exec(
    `CREATE TABLE IF NOT EXISTS upcoming_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       title TEXT NOT NULL,
       starts_at INTEGER,            -- epoch seconds (best-effort from on-screen text)
       ends_at INTEGER,
       location TEXT,                -- room / link / place
       attendees TEXT,              -- comma-joined names
       source_app TEXT,
       source_ts INTEGER,           -- when we saw it
       dedup_key TEXT UNIQUE,       -- title + day, normalized
       created_at INTEGER NOT NULL DEFAULT 0
     )`
  );
  ready = true;
}

export interface UpcomingEvent {
  id: number;
  title: string;
  starts_at: number | null;
  ends_at: number | null;
  location: string | null;
  attendees: string | null;
  source_app: string | null;
  source_ts: number | null;
}

/** Is this surface/url likely a calendar we can harvest upcoming events from? */
export function isCalendarSurface(appName: string, url: string, title: string): boolean {
  const hay = `${appName} ${url} ${title}`.toLowerCase();
  return (
    /calendar\.google\.com/.test(hay) ||
    /\bcalendar\b/.test(hay) ||
    /fantastical|outlook.*calendar|cron\b/.test(hay)
  );
}

function extractJson(s: string): string {
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  return a >= 0 && b > a ? s.slice(a, b + 1) : '[]';
}

function dayKey(sec: number | null): string {
  if (!sec) return 'noday';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Extract upcoming events from captured calendar/invite text and upsert them.
 * Best-effort + cheap; tolerates empty. `nowSec` anchors relative dates.
 * Returns the number of new/updated events.
 */
export async function extractCalendarEvents(
  material: string,
  appName: string,
  nowSec: number
): Promise<number> {
  ensure();
  if (!material || material.length < 40) return 0;

  const nowIso = new Date(nowSec * 1000).toISOString();
  const prompt = `Today is ${nowIso}. Below is text captured from a calendar or meeting invite on screen. Extract ONLY concrete UPCOMING events (in the future relative to today). Return a JSON array, each: {"title": "...", "start": "<ISO 8601 datetime or empty>", "end": "<ISO 8601 or empty>", "location": "<room/link/place or empty>", "attendees": ["names"]}. If no clear upcoming events, return []. No prose.

Captured text:
"""
${material.slice(0, 4000)}
"""`;

  let arr: Array<{ title?: string; start?: string; end?: string; location?: string; attendees?: string[] }> = [];
  try {
    const resp = await llm.chat(prompt, [], 90_000, 700, { temperature: 0.2, disableThinking: true });
    arr = JSON.parse(extractJson(resp));
  } catch {
    return 0;
  }
  if (!Array.isArray(arr) || !arr.length) return 0;

  const db = getDB();
  const insert = db.prepare(
    `INSERT INTO upcoming_events (title, starts_at, ends_at, location, attendees, source_app, source_ts, dedup_key, created_at)
     VALUES (@title, @starts_at, @ends_at, @location, @attendees, @source_app, @source_ts, @dedup_key, @created_at)
     ON CONFLICT(dedup_key) DO UPDATE SET
       starts_at = COALESCE(excluded.starts_at, starts_at),
       ends_at   = COALESCE(excluded.ends_at, ends_at),
       location  = COALESCE(excluded.location, location),
       attendees = COALESCE(excluded.attendees, attendees),
       source_ts = excluded.source_ts`
  );

  let n = 0;
  for (const e of arr) {
    const title = (e.title ?? '').trim();
    if (!title) continue;
    const startsAt = e.start ? Math.round(Date.parse(e.start) / 1000) || null : null;
    // Skip events clearly in the past.
    if (startsAt && startsAt < nowSec - 3600) continue;
    const endsAt = e.end ? Math.round(Date.parse(e.end) / 1000) || null : null;
    const attendees = Array.isArray(e.attendees) ? e.attendees.filter(Boolean).join(', ') : null;
    try {
      insert.run({
        title: title.slice(0, 200),
        starts_at: startsAt,
        ends_at: endsAt,
        location: (e.location ?? '').slice(0, 200) || null,
        attendees,
        source_app: appName,
        source_ts: nowSec,
        dedup_key: `${title.toLowerCase().slice(0, 80)}|${dayKey(startsAt)}`,
        created_at: nowSec,
      });
      n += 1;
    } catch {
      /* ignore one bad row */
    }
  }
  return n;
}

/** Upcoming events from now through `horizonSec` seconds ahead. */
export function listUpcomingEvents(nowSec: number, horizonSec = 7 * 86400): UpcomingEvent[] {
  ensure();
  return getDB()
    .prepare(
      `SELECT id, title, starts_at, ends_at, location, attendees, source_app, source_ts
       FROM upcoming_events
       WHERE starts_at IS NOT NULL AND starts_at >= ? AND starts_at <= ?
       ORDER BY starts_at ASC`
    )
    .all(nowSec - 3600, nowSec + horizonSec) as UpcomingEvent[];
}
