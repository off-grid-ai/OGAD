// Skills — reusable instruction packs the user drops into the .skills folder and
// invokes from chat with /skill-name (like Claude Code skills). Each skill is a
// folder under userData/.skills containing a SKILL.md with YAML-ish frontmatter
// (name, description) followed by the instruction body. A bare <name>.md directly
// under .skills also works. Everything is local; nothing leaves the machine.

import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import {
  parseSkill,
  slugify,
  triggerToFrontmatter,
  type Skill,
  type SkillTrigger
} from './skills-parse'
import { BUNDLED_SKILLS } from './skills-builtin'

// Re-export the pure types so existing importers of './skills' are unchanged.
export type { Skill }

export function skillsDir(): string {
  return path.join(app.getPath('userData'), '.skills')
}

const SAMPLE = `---
name: proofread
description: Fix grammar, spelling, and clarity without changing meaning or tone.
---
You are a careful proofreader. Correct grammar, spelling, and punctuation, and
improve clarity, but DO NOT change the meaning, voice, or tone. Return only the
corrected text. If the input is already clean, return it unchanged.
`

/** Create the .skills folder (and a sample skill) the first time it's needed. */
function ensureSkillsDir(): string {
  const dir = skillsDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    try {
      const sample = path.join(dir, 'proofread')
      fs.mkdirSync(sample, { recursive: true })
      fs.writeFileSync(path.join(sample, 'SKILL.md'), SAMPLE)
      fs.writeFileSync(
        path.join(dir, 'README.txt'),
        'Drop a skill here as <name>/SKILL.md (or <name>.md) with frontmatter:\n\n---\nname: my-skill\ndescription: what it does\n---\n<instructions>\n\nInvoke it in chat with /my-skill.\n'
      )
    } catch {
      /* best effort */
    }
  }
  const marker = path.join(dir, '.bundled-skills-v1')
  if (!fs.existsSync(marker)) {
    try {
      for (const skill of BUNDLED_SKILLS) {
        const folder = path.join(dir, skill.slug)
        if (fs.existsSync(folder)) continue
        fs.mkdirSync(folder, { recursive: true })
        fs.writeFileSync(path.join(folder, 'SKILL.md'), skill.markdown)
      }
      fs.writeFileSync(marker, 'Installed bundled skills v1.\n')
    } catch {
      /* A read-only profile still keeps manually installed skills available. */
    }
  }
  return dir
}

/** Read one skill from a .skills entry (folder with SKILL.md, or a .md file). */
function readEntry(dir: string, entry: string): Skill | null {
  const full = path.join(dir, entry)
  try {
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      const md = path.join(full, 'SKILL.md')
      if (fs.existsSync(md)) return parseSkill(fs.readFileSync(md, 'utf8'), entry)
      return null
    }
    if (entry.toLowerCase().endsWith('.md') && entry.toLowerCase() !== 'readme.md') {
      return parseSkill(fs.readFileSync(full, 'utf8'), entry.replace(/\.md$/i, ''))
    }
  } catch {
    /* skip */
  }
  return null
}

/** All installed skills (name + description; instructions omitted for the list). */
export function listSkills(): { name: string; description: string }[] {
  const dir = ensureSkillsDir()
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: { name: string; description: string }[] = []
  for (const e of entries) {
    const s = readEntry(dir, e)
    if (s && s.name) out.push({ name: s.name, description: s.description })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export interface SkillSaveInput {
  name: string
  description: string
  instructions: string
  originalName?: string
  trigger?: SkillTrigger | null
  action?: string
  connectors?: boolean
}

/** Create or update a skill folder (<slug>/SKILL.md). Renaming removes the old one. */
export function saveSkill(input: SkillSaveInput): Skill {
  const dir = ensureSkillsDir()
  const name = input.name.trim() || 'skill'
  if (input.originalName && input.originalName.trim().toLowerCase() !== name.toLowerCase()) {
    try {
      deleteSkill(input.originalName)
    } catch {
      /* best effort */
    }
  }
  const folder = path.join(dir, slugify(name))
  fs.mkdirSync(folder, { recursive: true })
  const lines = [`name: ${name}`, `description: ${input.description.trim()}`]
  if (input.trigger) {
    const { trigger, trigger_config } = triggerToFrontmatter(input.trigger)
    lines.push(`trigger: ${trigger}`, `trigger_config: ${trigger_config}`)
    if (input.action && input.action.trim())
      lines.push(`action: ${input.action.trim().replace(/\n/g, ' ')}`)
    lines.push(`connectors: ${input.connectors === false ? 'false' : 'true'}`)
  }
  const md = `---\n${lines.join('\n')}\n---\n${input.instructions.trim()}\n`
  fs.writeFileSync(path.join(folder, 'SKILL.md'), md)
  return parseSkill(md, name)
}

/** Delete a skill by name (removes its folder or .md file). */
export function deleteSkill(name: string): boolean {
  const dir = skillsDir()
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return false
  }
  const target = name.trim().toLowerCase()
  for (const e of entries) {
    const s = readEntry(dir, e)
    if (s && s.name.toLowerCase() === target) {
      try {
        fs.rmSync(path.join(dir, e), { recursive: true, force: true })
        return true
      } catch {
        return false
      }
    }
  }
  return false
}

/** Full skills that have an automation trigger (for the skills engine). */
export function listTriggeredSkills(): Skill[] {
  const dir = ensureSkillsDir()
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: Skill[] = []
  for (const e of entries) {
    const s = readEntry(dir, e)
    if (s && s.name && s.trigger) out.push(s)
  }
  return out
}

/** Full skill (with instructions) by name, case-insensitive. */
export function getSkill(name: string): Skill | null {
  const target = name.trim().toLowerCase()
  const dir = ensureSkillsDir()
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const e of entries) {
    const s = readEntry(dir, e)
    if (s && s.name.toLowerCase() === target) return s
  }
  return null
}
