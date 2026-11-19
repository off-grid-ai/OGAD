// A Settings card opens only through its section id: SETTINGS_SECTION_TITLES maps the id to the card's
// title, and a click on a card whose title has no id maps to no section, so the card stays shut. The
// Language card shipped that way. Every card title in Settings must have an id.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(__dirname, '..', 'Settings.tsx'), 'utf8')

function cardTitles(): string[] {
  return [...source.matchAll(/<SettingsCard\s+title="([^"]+)"/g)].map((m) => m[1])
}

function sectionTitles(): Set<string> {
  const map = source.match(/const SETTINGS_SECTION_TITLES[^{]*\{([\s\S]*?)\n\}/)
  if (!map) throw new Error('SETTINGS_SECTION_TITLES not found in Settings.tsx')
  return new Set([...map[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]))
}

describe('Settings: every card opens', () => {
  it('reads the cards (guards the check itself)', () => {
    expect(cardTitles()).toEqual(expect.arrayContaining(['Language', 'Backup & restore', 'UI']))
  })

  it('every card title has a section id, so a click opens it', () => {
    const ids = sectionTitles()
    expect(cardTitles().filter((title) => !ids.has(title))).toEqual([])
  })
})
