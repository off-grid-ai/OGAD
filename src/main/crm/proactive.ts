// Proactive delivery — the assistant reaches out without being asked.
//  • Morning briefing: once per day, a native notification summarizing the day
//    (built from the prospective "Ahead" plan).
//  • Meeting prep: ~20 min before a calendar event, a notification with who's in
//    it + open items (from getEventPrep).
// Everything is derived on-device; notifications fire from the MAIN process so
// they work even when the window is closed/minimized.

import { Notification, BrowserWindow } from 'electron';
import { getSetting, saveSetting } from '../database';
import { getDayPlan } from './ahead';
import { listUpcomingEvents } from './calendar';
import { getEventPrep } from './ahead';

const PREP_LEAD_MIN = 20; // notify ~20 min before
const PREP_WINDOW_MIN = 8; // catch events whose lead time falls in a ±window per tick

function today(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 10);
}
function localHour(nowSec: number): number {
  return new Date(nowSec * 1000).getHours();
}
function notify(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => { const w = BrowserWindow.getAllWindows()[0]; w?.show(); w?.focus(); });
    n.show();
  } catch (e) {
    console.error('[proactive] notify failed', e);
  }
}

/** Once per day (after 6am), push a morning briefing built from the Ahead plan. */
async function maybeMorningBriefing(nowSec: number): Promise<void> {
  if (localHour(nowSec) < 6) return; // don't ping at 3am
  const day = today(nowSec);
  if (getSetting<string>('proactive:lastBriefing', '') === day) return;
  let plan = '';
  try { plan = await getDayPlan(nowSec); } catch (e) { console.error('[proactive] day plan', e); }
  if (!plan || !plan.trim()) { saveSetting('proactive:lastBriefing', day); return; } // nothing to say; don't retry today
  const body = plan.trim().replace(/\s+/g, ' ').slice(0, 240);
  notify('Good morning — your day ahead', body);
  saveSetting('proactive:lastBriefing', day);
}

/** ~20 min before each upcoming event (once each), push a prep notification. */
function maybeMeetingPrep(nowSec: number): void {
  const events = listUpcomingEvents(nowSec, 60 * 60); // next hour
  const notified = new Set(getSetting<string[]>('proactive:notifiedEvents', []));
  let changed = false;
  for (const ev of events) {
    if (!ev.starts_at) continue;
    const leadMin = (ev.starts_at - nowSec) / 60;
    if (leadMin < PREP_LEAD_MIN - PREP_WINDOW_MIN || leadMin > PREP_LEAD_MIN + PREP_WINDOW_MIN) continue;
    const key = `${ev.title}|${ev.starts_at}`;
    if (notified.has(key)) continue;
    const prep = getEventPrep(ev.title, ev.attendees ? ev.attendees.split(/[,;]+/).map((s) => s.trim()) : []);
    const bits: string[] = [];
    if (prep.people.length) bits.push(`with ${prep.people.map((p) => p.name).join(', ')}`);
    if (prep.openItems.length) bits.push(`${prep.openItems.length} open item${prep.openItems.length > 1 ? 's' : ''}`);
    const body = bits.length ? bits.join(' · ') : 'Tap to see prep in Off Grid.';
    notify(`Meeting in ~${Math.round(leadMin)} min: ${ev.title}`, body.slice(0, 240));
    notified.add(key);
    changed = true;
  }
  if (changed) {
    // Keep only still-relevant keys (events whose start is within the last day).
    const keep = Array.from(notified).filter((k) => {
      const ts = Number(k.split('|').pop());
      return Number.isFinite(ts) && ts > nowSec - 86400;
    });
    saveSetting('proactive:notifiedEvents', keep);
  }
}

/** One proactive tick — safe to call frequently (every few minutes). */
export async function runProactive(nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  if (!getSetting<boolean>('proactive:enabled', true)) return; // user-silenced
  try { await maybeMorningBriefing(nowSec); } catch (e) { console.error('[proactive] briefing', e); }
  try { maybeMeetingPrep(nowSec); } catch (e) { console.error('[proactive] prep', e); }
}
