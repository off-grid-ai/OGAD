// "Ahead" — the prospective half of Day. Where Day/Reflect look BACK at what you
// did, Ahead looks FORWARD: your upcoming meetings (from calendar-via-capture),
// per-meeting prep pulled from memory, and the priorities you should tackle
// (open action items + meetings to follow up on). This is the tool→assistant
// pivot: "your day, before you ask for it." Fully on-device.

import { getDB } from '../database';
import { listActionItems } from './actions';
import { listUpcomingEvents, type UpcomingEvent } from './calendar';
import { listMeetings } from '../meetings';
import { isMe } from '../identity';
import { llm } from '../llm';

export interface AheadPriority {
  id: number;
  text: string;
  due: string | null;
  entityName: string | null;
  sourceApp: string | null;
  urgency: number; // estimated epoch-sec when it's "due" — smaller = sooner
}

export interface AheadFollowUp {
  id: number;
  title: string;
  summary: string | null;
  startedAt: number | null; // epoch ms
}

export interface AheadFocus {
  id: number;
  name: string;
  type: string;
  count: number;
}

export interface AheadView {
  now: number;
  upcoming: UpcomingEvent[];
  priorities: AheadPriority[];
  followUps: AheadFollowUp[];
  focus: AheadFocus[];
}

// Light heuristic: turn a free-text due ("by Friday", "EOD", "tomorrow") into a
// rough epoch-sec for sorting. Not a real date parser — just enough to float the
// urgent things to the top. Falls back to "a few days out".
function dueUrgency(due: string | null, nowSec: number): number {
  if (!due) return nowSec + 3 * 86400;
  const d = due.toLowerCase();
  if (/(asap|now|immediately|eod|today|tonight)/.test(d)) return nowSec;
  if (/tomorrow|eod tomorrow|next day/.test(d)) return nowSec + 86400;
  if (/this week|by (the )?week|friday|fri\b/.test(d)) return nowSec + 3 * 86400;
  if (/next week|mon|tue|wed|thu/.test(d)) return nowSec + 7 * 86400;
  if (/month|eom/.test(d)) return nowSec + 21 * 86400;
  // Try a literal date.
  const t = Date.parse(due);
  if (!Number.isNaN(t)) return Math.round(t / 1000);
  return nowSec + 3 * 86400;
}

/** Top entities by recent activity (last `windowSec`) — "what you're focused on". */
function topFocus(nowSec: number, windowSec: number, limit: number): AheadFocus[] {
  return getDB()
    .prepare(
      `SELECT e.id, e.name, e.type, COUNT(*) AS count
       FROM observation_entities oe
       JOIN observations o ON o.id = oe.observation_id
       JOIN entities e ON e.id = oe.entity_id
       WHERE e.hidden = 0
         AND strftime('%s', o.ts) >= ?
       GROUP BY e.id
       ORDER BY count DESC
       LIMIT ?`
    )
    .all(String(nowSec - windowSec), limit) as AheadFocus[];
}

// ---------------------------------------------------------------------------
// Day plan — the synthesized briefing. Turns calendar + to-dos + recent email
// into a short, prioritized plan with the local LLM. Cached per day.
// ---------------------------------------------------------------------------

function ensureDayPlanTable(): void {
  getDB().exec(`CREATE TABLE IF NOT EXISTS day_plans (day_key INTEGER PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)`);
}
function dayKeyOf(nowSec: number): number {
  const d = new Date(nowSec * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}
function storedPlan(dayKey: number): string {
  ensureDayPlanTable();
  const row = getDB().prepare('SELECT text FROM day_plans WHERE day_key = ?').get(dayKey) as { text: string } | undefined;
  return row?.text ?? '';
}
function hhmm(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The cached plan for the day, instantly (no LLM). */
export function getDayPlanCached(nowSec: number): string {
  return storedPlan(dayKeyOf(nowSec));
}

/** Generate (and cache) the synthesized plan for today from calendar + to-dos + email. */
export async function getDayPlan(nowSec: number): Promise<string> {
  ensureDayPlanTable();
  const key = dayKeyOf(nowSec);
  const view = getAhead(nowSec);
  const emails = getDB()
    .prepare(`SELECT summary FROM observations WHERE surface = 'Gmail' ORDER BY ts DESC LIMIT 12`)
    .all() as { summary: string }[];

  const events = view.upcoming.length
    ? view.upcoming.map((e) => `- ${e.starts_at ? hhmm(e.starts_at) : '?'} ${e.title}${e.attendees ? ` (with ${e.attendees})` : ''}`).join('\n')
    : '(no meetings today)';
  const todos = view.priorities.length
    ? view.priorities.slice(0, 18).map((p) => `- ${p.text}${p.due ? ` [due ${p.due}]` : ''}${p.entityName ? ` (re ${p.entityName})` : ''}`).join('\n')
    : '(none flagged)';
  const mail = emails.length ? emails.map((e) => `- ${e.summary}`).join('\n') : '(none)';

  const prompt = `You are my sharp, no-nonsense chief of staff. Using my calendar, to-dos, and recent emails for TODAY, write me a short daily plan that makes me feel organized and in control.

Write it as:
1. One or two sentences orienting me to the day — how many meetings, the overall shape, anything urgent or time-sensitive.
2. A prioritized list of 3-6 concrete things to focus on, in the order I should tackle them. Weave in prep for the meetings and follow-ups implied by the emails. Reference specific people, projects, and times.

Be decisive and specific — tell me what matters and what to ignore. No preamble, no headings, under 200 words. Address me as "you".

TODAY'S MEETINGS:
${events}

OPEN TO-DOS:
${todos}

RECENT EMAILS (subjects/snippets):
${mail}`;

  try {
    const text = (await llm.chat(prompt, [], 120_000, 600, { temperature: 0.4, disableThinking: true })).trim();
    if (text) {
      getDB()
        .prepare(`INSERT INTO day_plans (day_key, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(day_key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`)
        .run(key, text, Date.now());
    }
    return text || storedPlan(key);
  } catch (e) {
    console.error('[day plan] failed:', e);
    return storedPlan(key);
  }
}

export interface EventPrep {
  people: { id: number; name: string; type: string; summary: string | null }[];
  recent: { summary: string; surface: string; ts: string }[];
  openItems: { id: number; text: string; due: string | null }[];
}

// Candidate names from an event title — handles "Kunal <> Mac", "X and Y",
// "Meeting with Z", "A / B". Liberal: the entity lookup filters to real ones.
function titleNames(title: string): string[] {
  return title
    .replace(/\b(meeting|sync|call|with|between|and|the|weekly|biweekly|catch[- ]?up|1[:x ]?1|discovery|intro)\b/gi, '|')
    .split(/[<>/|:,&]+|\s-\s/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && /[A-Za-z]/.test(s));
}

/** Meeting prep: who's in it + what you've discussed + open items — from memory. */
export function getEventPrep(title: string, attendees: string[]): EventPrep {
  // Exclude the user themselves (any known alias) — prep is about the OTHER
  // people, not you (otherwise "Kunal <> Mac" pulls all of your own activity).
  const names = Array.from(
    new Set([...attendees, ...titleNames(title)].map((s) => s.trim()).filter((n) => n.length > 1 && !isMe(n)))
  ).slice(0, 12);
  if (!names.length) return { people: [], recent: [], openItems: [] };
  const db = getDB();
  const ph = names.map(() => '?').join(',');

  const people = db
    .prepare(`SELECT id, name, type, summary FROM entities WHERE hidden = 0 AND name IN (${ph}) COLLATE NOCASE LIMIT 12`)
    .all(...names) as EventPrep['people'];

  let recent: EventPrep['recent'] = [];
  if (people.length) {
    const ids = people.map((p) => p.id);
    const ip = ids.map(() => '?').join(',');
    recent = db
      .prepare(
        `SELECT DISTINCT o.summary AS summary, o.surface AS surface, o.ts AS ts
         FROM observations o JOIN observation_entities oe ON oe.observation_id = o.id
         WHERE oe.entity_id IN (${ip})
         ORDER BY o.ts DESC LIMIT 10`
      )
      .all(...ids) as EventPrep['recent'];
  }

  const openItems = db
    .prepare(
      `SELECT id, text, due FROM action_items
       WHERE status = 'open' AND entity_name IN (${ph}) COLLATE NOCASE
       ORDER BY COALESCE(source_ts, created_at) DESC LIMIT 10`
    )
    .all(...names) as EventPrep['openItems'];

  return { people, recent, openItems };
}

/**
 * Build the prospective view. `nowSec` is "right now" in epoch seconds.
 * Everything is derived from data already on the device.
 */
export function getAhead(nowSec: number): AheadView {
  // TODAY only — this is a daily assistant, not a calendar app. Remaining events
  // through end of the local day.
  const eod = new Date(nowSec * 1000);
  eod.setHours(23, 59, 59, 999);
  const upcoming = listUpcomingEvents(nowSec, Math.max(0, Math.floor(eod.getTime() / 1000) - nowSec));

  // Priorities = open action items, soonest-due first.
  const priorities: AheadPriority[] = listActionItems()
    .filter((a) => a.status === 'open')
    .map((a) => ({
      id: a.id,
      text: a.text,
      due: a.due ?? null,
      entityName: a.entity_name ?? null,
      sourceApp: a.source_app ?? null,
      urgency: dueUrgency(a.due ?? null, nowSec),
    }))
    .sort((x, y) => x.urgency - y.urgency)
    .slice(0, 25);

  // Follow-ups = meetings in the last 7 days worth acting on.
  const weekAgoMs = (nowSec - 7 * 86400) * 1000;
  const followUps: AheadFollowUp[] = listMeetings(30)
    .filter((m) => (m.started_at ?? 0) >= weekAgoMs)
    .slice(0, 8)
    .map((m) => ({ id: m.id, title: m.title ?? 'Meeting', summary: m.summary ?? null, startedAt: m.started_at ?? null }));

  const focus = topFocus(nowSec, 7 * 86400, 6);

  return { now: nowSec, upcoming, priorities, followUps, focus };
}
