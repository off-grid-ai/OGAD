// Reflect: turn the day's observations into a "mind share" breakdown — where
// your attention actually went (by project/topic = the things you THINK about),
// the balance of work vs communication vs consumption, and how fragmented the
// day was (context switching, focus streaks). Pure reflection layer over the
// captured stream — no new capture.

import { getDB } from '../database';
import { migrateCrm } from './schema';

export interface Slice {
  key: string;
  name: string;
  type: string;
  sec: number;
  pct: number;
}

export interface DayReflection {
  totalActiveSec: number;
  observationCount: number;
  mindShare: Slice[]; // time per entity (project/topic/person) — what you thought about
  categories: { category: string; sec: number; pct: number }[]; // work/comm/consumption balance
  apps: { app: string; sec: number; pct: number }[];
  contextSwitches: number; // times you jumped between areas
  switchesPerHour: number;
  longestFocusSec: number; // longest unbroken stretch on one area
  avgFocusSec: number; // mean focus stretch
}

// Each observation is a sample; we attribute the gap until the next sample as
// dwell on that moment's area. Cap the gap so an idle/away stretch doesn't count
// as "focus", and give the final sample a small fixed tail.
const DWELL_CAP_SEC = 5 * 60;
const LAST_DWELL_SEC = 45;

const EMPTY: DayReflection = {
  totalActiveSec: 0,
  observationCount: 0,
  mindShare: [],
  categories: [],
  apps: [],
  contextSwitches: 0,
  switchesPerHour: 0,
  longestFocusSec: 0,
  avgFocusSec: 0,
};

export function getDayReflection(startSec: number, endSec: number): DayReflection {
  migrateCrm();
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT o.id AS id,
              COALESCE(o.surface, o.surface_app, 'Unknown') AS app,
              COALESCE(o.category, 'other') AS cat,
              CAST(strftime('%s', o.ts) AS INTEGER) AS sec
       FROM observations o
       WHERE CAST(strftime('%s', o.ts) AS INTEGER) BETWEEN ? AND ?
       ORDER BY sec ASC`
    )
    .all(startSec, endSec) as { id: number; app: string; cat: string; sec: number }[];

  if (rows.length === 0) return EMPTY;

  // Non-hidden entities for an observation (the "areas" you think about).
  const entStmt = db.prepare(
    `SELECT e.id AS id, e.name AS name, e.type AS type
     FROM entities e JOIN observation_entities oe ON oe.entity_id = e.id
     WHERE oe.observation_id = ? AND e.hidden = 0`
  );

  const byEntity = new Map<string, { name: string; type: string; sec: number }>();
  const byCat = new Map<string, number>();
  const byApp = new Map<string, number>();
  // Per-sample area + dwell, for switch / focus-streak analysis.
  const items: { area: string; dwell: number }[] = [];
  let total = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const next = rows[i + 1];
    let dwell = next ? Math.min(DWELL_CAP_SEC, Math.max(0, next.sec - r.sec)) : LAST_DWELL_SEC;
    if (dwell <= 0) dwell = 1;
    total += dwell;
    byApp.set(r.app, (byApp.get(r.app) ?? 0) + dwell);
    byCat.set(r.cat, (byCat.get(r.cat) ?? 0) + dwell);

    const ents = entStmt.all(r.id) as { id: number; name: string; type: string }[];
    if (ents.length) {
      const split = dwell / ents.length; // a moment can be about >1 thing — split, don't double-count
      for (const e of ents) {
        const k = String(e.id);
        const cur = byEntity.get(k) ?? { name: e.name, type: e.type, sec: 0 };
        cur.sec += split;
        byEntity.set(k, cur);
      }
      items.push({ area: `e${ents[0].id}`, dwell }); // primary area = first entity
    } else {
      // No entity — consumption/browsing or unclassified. Still real attention.
      const label = r.cat === 'consumption' ? 'Browsing / feeds' : 'Untracked';
      const key = r.cat === 'consumption' ? '_consumption' : '_untracked';
      const cur = byEntity.get(key) ?? { name: label, type: '', sec: 0 };
      cur.sec += dwell;
      byEntity.set(key, cur);
      items.push({ area: key, dwell });
    }
  }

  // Context switches + focus streaks over the area sequence.
  let switches = 0;
  let longest = 0;
  let run = 0;
  const runs: number[] = [];
  for (let i = 0; i < items.length; i++) {
    run += items[i].dwell;
    const changed = i > 0 && items[i].area !== items[i - 1].area;
    if (changed) {
      switches += 1;
      runs.push(run - items[i].dwell);
      longest = Math.max(longest, run - items[i].dwell);
      run = items[i].dwell;
    }
  }
  runs.push(run);
  longest = Math.max(longest, run);
  const avgFocus = runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : 0;
  const hours = total / 3600;

  const mindShare: Slice[] = [...byEntity.entries()]
    .map(([key, v]) => ({ key, name: v.name, type: v.type, sec: Math.round(v.sec), pct: total ? v.sec / total : 0 }))
    .sort((a, b) => b.sec - a.sec);

  const categories = [...byCat.entries()]
    .map(([category, sec]) => ({ category, sec: Math.round(sec), pct: total ? sec / total : 0 }))
    .sort((a, b) => b.sec - a.sec);

  const apps = [...byApp.entries()]
    .map(([app, sec]) => ({ app, sec: Math.round(sec), pct: total ? sec / total : 0 }))
    .sort((a, b) => b.sec - a.sec)
    .slice(0, 10);

  return {
    totalActiveSec: Math.round(total),
    observationCount: rows.length,
    mindShare,
    categories,
    apps,
    contextSwitches: switches,
    switchesPerHour: hours > 0 ? Math.round(switches / hours) : 0,
    longestFocusSec: Math.round(longest),
    avgFocusSec: Math.round(avgFocus),
  };
}

export interface DayTrend {
  dayStartSec: number;
  totalActiveSec: number;
  work: number;
  communication: number;
  consumption: number;
  other: number;
  switchesPerHour: number;
  longestFocusSec: number;
}
export interface WeekReflection {
  days: DayTrend[]; // oldest → newest, length 7
  mindShare: Slice[]; // aggregated across the week
  totalActiveSec: number;
  avgSwitchesPerHour: number;
  deepWorkSec: number; // total time in work category
}

/** 7 days ending on (and including) anchorDayStartSec — daily trend + week totals. */
export function getWeekReflection(anchorDayStartSec: number): WeekReflection {
  const days: DayTrend[] = [];
  const agg = new Map<string, { name: string; type: string; sec: number }>();
  let total = 0;
  let swSum = 0;
  let swDays = 0;
  let deepWork = 0;
  for (let i = 6; i >= 0; i--) {
    const s = anchorDayStartSec - i * 86400;
    const r = getDayReflection(s, s + 86400);
    const cat = (k: string): number => r.categories.find((c) => c.category === k)?.sec ?? 0;
    const work = cat('work');
    days.push({
      dayStartSec: s,
      totalActiveSec: r.totalActiveSec,
      work,
      communication: cat('communication'),
      consumption: cat('consumption'),
      other: cat('other'),
      switchesPerHour: r.switchesPerHour,
      longestFocusSec: r.longestFocusSec,
    });
    total += r.totalActiveSec;
    deepWork += work;
    if (r.totalActiveSec > 0) {
      swSum += r.switchesPerHour;
      swDays += 1;
    }
    for (const sl of r.mindShare) {
      const cur = agg.get(sl.key) ?? { name: sl.name, type: sl.type, sec: 0 };
      cur.sec += sl.sec;
      agg.set(sl.key, cur);
    }
  }
  const mindShare = [...agg.entries()]
    .map(([key, v]) => ({ key, name: v.name, type: v.type, sec: Math.round(v.sec), pct: total ? v.sec / total : 0 }))
    .sort((a, b) => b.sec - a.sec);
  return {
    days,
    mindShare,
    totalActiveSec: Math.round(total),
    avgSwitchesPerHour: swDays ? Math.round(swSum / swDays) : 0,
    deepWorkSec: Math.round(deepWork),
  };
}
