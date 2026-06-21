// "Ahead" — the prospective half of Day. Where Day/Reflect look BACK at what you
// did, Ahead looks FORWARD: your upcoming meetings (from calendar-via-capture),
// per-meeting prep pulled from memory, and the priorities you should tackle
// (open action items + meetings to follow up on). This is the tool→assistant
// pivot: "your day, before you ask for it." Fully on-device.

import { getDB } from '../database';
import { listActionItems } from './actions';
import { listUpcomingEvents, type UpcomingEvent } from './calendar';
import { listMeetings } from '../meetings';

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

/**
 * Build the prospective view. `nowSec` is "right now" in epoch seconds.
 * Everything is derived from data already on the device.
 */
export function getAhead(nowSec: number): AheadView {
  // Upcoming meetings (calendar-via-capture), next 7 days.
  const upcoming = listUpcomingEvents(nowSec, 7 * 86400);

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
