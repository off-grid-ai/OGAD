// Skills — reusable instruction packs the user drops into the .skills folder and
// invokes from chat with /skill-name (like Claude Code skills). Each skill is a
// folder under userData/.skills containing a SKILL.md with YAML-ish frontmatter
// (name, description) followed by the instruction body. A bare <name>.md directly
// under .skills also works. Everything is local; nothing leaves the machine.

import { app } from 'electron';
import path from 'path';
import fs from 'fs';

// A skill can optionally fire on its own (trigger → action) instead of only
// being invoked manually with /name in chat:
//  • schedule — once a day at a local HH:MM
//  • keyword  — when a keyword appears in a newly captured observation
//  • event    — when a new calendar event or approval appears
export type SkillTrigger =
  | { kind: 'schedule'; at: string } // 'HH:MM' local time, daily
  | { kind: 'keyword'; keywords: string[] }
  | { kind: 'event'; on: 'calendar' | 'approval' };

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  // Automation (optional; absent = manual /name skill, unchanged behavior):
  trigger?: SkillTrigger;
  action?: string; // prompt run when triggered (falls back to instructions)
  connectors?: boolean; // expose MCP connector tools to the action (default true)
}

function parseTrigger(kind: string, config: string): SkillTrigger | undefined {
  const c = config.trim();
  if (kind === 'schedule') return { kind: 'schedule', at: /^\d{1,2}:\d{2}$/.test(c) ? c : '08:00' };
  if (kind === 'keyword') {
    const keywords = c.split(',').map((s) => s.trim()).filter(Boolean);
    return keywords.length ? { kind: 'keyword', keywords } : undefined;
  }
  if (kind === 'event') return { kind: 'event', on: c.toLowerCase() === 'approval' ? 'approval' : 'calendar' };
  return undefined;
}

function triggerToFrontmatter(t: SkillTrigger): { trigger: string; trigger_config: string } {
  if (t.kind === 'schedule') return { trigger: 'schedule', trigger_config: t.at };
  if (t.kind === 'keyword') return { trigger: 'keyword', trigger_config: t.keywords.join(', ') };
  return { trigger: 'event', trigger_config: t.on };
}

export function skillsDir(): string {
  return path.join(app.getPath('userData'), '.skills');
}

const SAMPLE = `---
name: proofread
description: Fix grammar, spelling, and clarity without changing meaning or tone.
---
You are a careful proofreader. Correct grammar, spelling, and punctuation, and
improve clarity, but DO NOT change the meaning, voice, or tone. Return only the
corrected text. If the input is already clean, return it unchanged.
`;

/** Create the .skills folder (and a sample skill) the first time it's needed. */
function ensureSkillsDir(): string {
  const dir = skillsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      const sample = path.join(dir, 'proofread');
      fs.mkdirSync(sample, { recursive: true });
      fs.writeFileSync(path.join(sample, 'SKILL.md'), SAMPLE);
      fs.writeFileSync(
        path.join(dir, 'README.txt'),
        'Drop a skill here as <name>/SKILL.md (or <name>.md) with frontmatter:\n\n---\nname: my-skill\ndescription: what it does\n---\n<instructions>\n\nInvoke it in chat with /my-skill.\n'
      );
    } catch {
      /* best effort */
    }
  }
  return dir;
}

/** Parse `---\nname: ...\ndescription: ...\n---\n<body>` into its parts. */
function parseSkill(md: string, fallbackName: string): Skill {
  let name = fallbackName;
  let description = '';
  let body = md;
  let triggerKind = '';
  let triggerConfig = '';
  let action = '';
  let connectors = true;
  const fm = /^﻿?---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md);
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split('\n')) {
      const m = /^\s*([A-Za-z_]+)\s*:\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].replace(/^["']|["']$/g, '');
      if (key === 'name') name = val;
      else if (key === 'description') description = val;
      else if (key === 'trigger') triggerKind = val.toLowerCase();
      else if (key === 'trigger_config') triggerConfig = val;
      else if (key === 'action') action = val;
      else if (key === 'connectors') connectors = val.toLowerCase() !== 'false';
    }
  }
  const skill: Skill = { name: name.trim(), description: description.trim(), instructions: body.trim() };
  const trigger = triggerKind ? parseTrigger(triggerKind, triggerConfig) : undefined;
  if (trigger) {
    skill.trigger = trigger;
    skill.action = action.trim();
    skill.connectors = connectors;
  }
  return skill;
}

/** Read one skill from a .skills entry (folder with SKILL.md, or a .md file). */
function readEntry(dir: string, entry: string): Skill | null {
  const full = path.join(dir, entry);
  try {
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      const md = path.join(full, 'SKILL.md');
      if (fs.existsSync(md)) return parseSkill(fs.readFileSync(md, 'utf8'), entry);
      return null;
    }
    if (entry.toLowerCase().endsWith('.md') && entry.toLowerCase() !== 'readme.md') {
      return parseSkill(fs.readFileSync(full, 'utf8'), entry.replace(/\.md$/i, ''));
    }
  } catch {
    /* skip */
  }
  return null;
}

/** All installed skills (name + description; instructions omitted for the list). */
export function listSkills(): { name: string; description: string }[] {
  const dir = ensureSkillsDir();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: { name: string; description: string }[] = [];
  for (const e of entries) {
    const s = readEntry(dir, e);
    if (s && s.name) out.push({ name: s.name, description: s.description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
}

export interface SkillSaveInput {
  name: string;
  description: string;
  instructions: string;
  originalName?: string;
  trigger?: SkillTrigger | null;
  action?: string;
  connectors?: boolean;
}

/** Create or update a skill folder (<slug>/SKILL.md). Renaming removes the old one. */
export function saveSkill(input: SkillSaveInput): Skill {
  const dir = ensureSkillsDir();
  const name = input.name.trim() || 'skill';
  if (input.originalName && input.originalName.trim().toLowerCase() !== name.toLowerCase()) {
    try { deleteSkill(input.originalName); } catch { /* best effort */ }
  }
  const folder = path.join(dir, slugify(name));
  fs.mkdirSync(folder, { recursive: true });
  const lines = [`name: ${name}`, `description: ${input.description.trim()}`];
  if (input.trigger) {
    const { trigger, trigger_config } = triggerToFrontmatter(input.trigger);
    lines.push(`trigger: ${trigger}`, `trigger_config: ${trigger_config}`);
    if (input.action && input.action.trim()) lines.push(`action: ${input.action.trim().replace(/\n/g, ' ')}`);
    lines.push(`connectors: ${input.connectors === false ? 'false' : 'true'}`);
  }
  const md = `---\n${lines.join('\n')}\n---\n${input.instructions.trim()}\n`;
  fs.writeFileSync(path.join(folder, 'SKILL.md'), md);
  return parseSkill(md, name);
}

/** Delete a skill by name (removes its folder or .md file). */
export function deleteSkill(name: string): boolean {
  const dir = skillsDir();
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return false; }
  const target = name.trim().toLowerCase();
  for (const e of entries) {
    const s = readEntry(dir, e);
    if (s && s.name.toLowerCase() === target) {
      try { fs.rmSync(path.join(dir, e), { recursive: true, force: true }); return true; } catch { return false; }
    }
  }
  return false;
}

/** Full skills that have an automation trigger (for the skills engine). */
export function listTriggeredSkills(): Skill[] {
  const dir = ensureSkillsDir();
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out: Skill[] = [];
  for (const e of entries) {
    const s = readEntry(dir, e);
    if (s && s.name && s.trigger) out.push(s);
  }
  return out;
}

/** Full skill (with instructions) by name, case-insensitive. */
export function getSkill(name: string): Skill | null {
  const target = name.trim().toLowerCase();
  const dir = ensureSkillsDir();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const e of entries) {
    const s = readEntry(dir, e);
    if (s && s.name.toLowerCase() === target) return s;
  }
  return null;
}
