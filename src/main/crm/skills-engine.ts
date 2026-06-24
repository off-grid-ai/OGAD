// Skills engine — runs trigger→action skills on their own. Polled from the same
// proactive tick (no insert-site hooks): each skill kind is checked, and on a
// match the skill's action runs through the agentic tool loop (with MCP
// connectors, so writes still route to the approval queue) and the result is
// delivered as a native notification.
//
//  • schedule — once a day at a local HH:MM
//  • keyword  — when a keyword appears in an observation captured AFTER the skill
//               was first seen (per-skill id cursor, so it never fires on backlog)
//  • event    — when a new calendar event / approval appears after the cursor
//
// Cursors + per-day fire flags live in settings, keyed by skill name.

import { Notification, BrowserWindow } from 'electron';
import { getDB, getSetting, saveSetting } from '../database';
import { migrateCrm } from './schema';
import { listTriggeredSkills, type Skill } from '../skills';

function notify(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body: body.slice(0, 240), silent: false });
    n.on('click', () => { const w = BrowserWindow.getAllWindows()[0]; w?.show(); w?.focus(); });
    n.show();
  } catch (e) {
    console.error('[skills] notify failed', e);
  }
}

function today(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 10);
}
function minutesOfDay(nowSec: number): number {
  const d = new Date(nowSec * 1000);
  return d.getHours() * 60 + d.getMinutes();
}
function atToMinutes(at: string): number {
  const [h, m] = at.split(':').map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}
function maxId(table: string): number {
  try {
    const r = getDB().prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number };
    return r?.m ?? 0;
  } catch { return 0; }
}

/** Run a skill's action through the agentic tool loop and notify with the result. */
async function fire(skill: Skill, reason: string, context: string): Promise<void> {
  const prompt = [
    skill.action || skill.instructions,
    context ? `\n\nContext that triggered this (${reason}):\n${context}` : '',
  ].join('');
  try {
    const { toolChat } = await import('../../main/tools');
    const r = await toolChat(prompt, [], { connectors: skill.connectors !== false });
    const answer = (r?.answer || '').trim();
    notify(`Skill: ${skill.name}`, answer || `Ran on ${reason}.`);
    console.log(`[skills] fired "${skill.name}" (${reason})`);
  } catch (e) {
    console.error(`[skills] action failed for "${skill.name}"`, e);
  }
}

async function evalSchedule(skill: Skill, nowSec: number): Promise<void> {
  if (skill.trigger?.kind !== 'schedule') return;
  const day = today(nowSec);
  const key = `skill:${skill.name}:lastSchedDay`;
  if (getSetting<string>(key, '') === day) return; // already fired today
  if (minutesOfDay(nowSec) < atToMinutes(skill.trigger.at)) return; // time not reached
  saveSetting(key, day); // mark before firing so a slow action can't double-fire
  await fire(skill, `daily schedule at ${skill.trigger.at}`, '');
}

async function evalKeyword(skill: Skill): Promise<void> {
  if (skill.trigger?.kind !== 'keyword') return;
  const key = `skill:${skill.name}:lastObsId`;
  const cursor = getSetting<number>(key, -1);
  const top = maxId('observations');
  if (cursor < 0) { saveSetting(key, top); return; } // first sight → start fresh, no backlog
  if (top <= cursor) return;
  const rows = getDB()
    .prepare('SELECT id, summary FROM observations WHERE id > ? ORDER BY id ASC LIMIT 50')
    .all(cursor) as { id: number; summary: string }[];
  saveSetting(key, top);
  const kws = skill.trigger.keywords.map((k) => k.toLowerCase());
  const hits = rows.filter((r) => { const s = (r.summary || '').toLowerCase(); return kws.some((k) => s.includes(k)); });
  if (!hits.length) return;
  const context = hits.slice(0, 5).map((h) => `- ${h.summary}`).join('\n');
  await fire(skill, `keyword (${skill.trigger.keywords.join(', ')})`, context);
}

async function evalEvent(skill: Skill, _nowSec: number): Promise<void> {
  if (skill.trigger?.kind !== 'event') return;
  const table = skill.trigger.on === 'approval' ? 'approvals' : 'upcoming_events';
  const key = `skill:${skill.name}:last:${table}`;
  const cursor = getSetting<number>(key, -1);
  const top = maxId(table);
  if (cursor < 0) { saveSetting(key, top); return; } // first sight → no backlog
  if (top <= cursor) return;
  // For approvals, ignore ones a skill/chat action itself proposed (source='chat')
  // so a skill can't trigger on the very approval it just created (infinite loop).
  const where = table === 'approvals'
    ? `id > ? AND COALESCE(source,'') != 'chat'`
    : `id > ?`;
  const rows = getDB()
    .prepare(`SELECT id, title FROM ${table} WHERE ${where} ORDER BY id ASC LIMIT 20`)
    .all(cursor) as { id: number; title: string }[];
  saveSetting(key, top);
  if (!rows.length) return;
  const context = rows.slice(0, 5).map((r) => `- ${r.title}`).join('\n');
  await fire(skill, `new ${skill.trigger.on === 'approval' ? 'approval' : 'calendar event'}`, context);
}

/** One tick — evaluate every triggered skill. Safe to call every few minutes. */
export async function runSkillTriggers(nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  migrateCrm();
  let skills: Skill[] = [];
  try { skills = listTriggeredSkills(); } catch (e) { console.error('[skills] list', e); return; }
  for (const skill of skills) {
    try {
      if (skill.trigger?.kind === 'schedule') await evalSchedule(skill, nowSec);
      else if (skill.trigger?.kind === 'keyword') await evalKeyword(skill);
      else if (skill.trigger?.kind === 'event') await evalEvent(skill, nowSec);
    } catch (e) {
      console.error(`[skills] eval "${skill.name}"`, e);
    }
  }
}
