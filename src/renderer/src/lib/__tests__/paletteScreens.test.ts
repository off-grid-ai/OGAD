import { describe, it, expect } from 'vitest'
import { matchesScreen, paletteScreenMatches } from '../paletteScreens'

// ⌘K has to find a screen by the word the user reaches for, not only by the label we chose for the
// sidebar - and it must never crowd out the content results it already searched.
describe('command palette screen matching', () => {
  const settings = { label: 'Settings', view: 'settings' }
  const devices = { label: 'Devices', view: 'devices' }

  it('matches on the label, case-insensitively and part-way through typing', () => {
    expect(matchesScreen(settings, 'set')).toBe(true)
    expect(matchesScreen(settings, 'SETTINGS')).toBe(true)
    expect(matchesScreen(devices, 'dev')).toBe(true)
  })

  it('matches the words people use instead of our label', () => {
    expect(matchesScreen(settings, 'preferences')).toBe(true)
    expect(matchesScreen(devices, 'sync')).toBe(true)
    expect(matchesScreen(devices, 'pairing')).toBe(true)
    expect(matchesScreen({ label: 'Integrations', view: 'connectors' }, 'mcp')).toBe(true)
  })

  it('does not match an unrelated word', () => {
    expect(matchesScreen(settings, 'replay')).toBe(false)
    expect(matchesScreen(devices, 'gguf')).toBe(false)
  })

  it('keeps a locked screen findable, so the upgrade path is reachable from the palette', () => {
    expect(matchesScreen({ label: 'Vault', view: 'vault', locked: true }, 'passwords')).toBe(true)
  })

  it('lists every screen with nothing typed, and only matches once something is', () => {
    const all = [settings, devices, { label: 'Models', view: 'models' }]
    expect(paletteScreenMatches(all, '')).toHaveLength(3)
    expect(paletteScreenMatches(all, 'sync').map((screen) => screen.view)).toEqual(['devices'])
  })

  it('caps the screen group so content results stay on screen', () => {
    const all = [settings, devices, { label: 'Models', view: 'models' }]
    expect(paletteScreenMatches(all, 'e', 2)).toHaveLength(2)
  })
})
