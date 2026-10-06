import { describe, it, expect } from 'vitest'
import { deviceNoun, isMac, modifierLabel, primaryModifier, shortcutLabel } from '../device'

describe('deviceNoun', () => {
  it('names macOS the Mac (brand proper noun)', () => {
    expect(deviceNoun('darwin')).toBe('Mac')
  })

  it('names Windows as "Windows PC"', () => {
    expect(deviceNoun('win32')).toBe('Windows PC')
  })

  it('names Linux as "Linux computer"', () => {
    expect(deviceNoun('linux')).toBe('Linux computer')
  })

  it('falls back to "device" for any other/unknown platform', () => {
    expect(deviceNoun('freebsd')).toBe('device')
    expect(deviceNoun('unknown')).toBe('device')
    expect(deviceNoun('')).toBe('device')
  })

  describe('capitalize option', () => {
    it('keeps platform names capitalized for sentence-initial use', () => {
      expect(deviceNoun('win32', { capitalize: true })).toBe('Windows PC')
      expect(deviceNoun('linux', { capitalize: true })).toBe('Linux computer')
    })

    it('leaves "Mac" unchanged (already capitalized)', () => {
      expect(deviceNoun('darwin', { capitalize: true })).toBe('Mac')
    })

    it('is a no-op when capitalize is false/omitted', () => {
      expect(deviceNoun('win32', { capitalize: false })).toBe('Windows PC')
      expect(deviceNoun('darwin')).toBe('Mac')
    })
  })
})

describe('isMac', () => {
  it('is true only on darwin', () => {
    expect(isMac('darwin')).toBe(true)
  })

  it('is false on every non-macOS platform', () => {
    expect(isMac('win32')).toBe(false)
    expect(isMac('linux')).toBe(false)
    expect(isMac('freebsd')).toBe(false)
    expect(isMac('unknown')).toBe(false)
    expect(isMac('')).toBe(false)
  })
})

describe('primaryModifier', () => {
  it('is "Cmd" on macOS', () => {
    expect(primaryModifier('darwin')).toBe('Cmd')
  })

  it('is "Ctrl" on Windows/Linux/other (matches CommandOrControl)', () => {
    expect(primaryModifier('win32')).toBe('Ctrl')
    expect(primaryModifier('linux')).toBe('Ctrl')
    expect(primaryModifier('unknown')).toBe('Ctrl')
    expect(primaryModifier('')).toBe('Ctrl')
  })
})

describe('shortcutLabel', () => {
  it('names the registered Alt+Space chord the way each keyboard labels it', () => {
    expect(shortcutLabel('Alt+Space', 'darwin')).toBe('Option+Space')
    expect(shortcutLabel('Alt+Space', 'win32')).toBe('Alt+Space')
  })

  it('resolves CommandOrControl through the platform primary modifier', () => {
    expect(shortcutLabel('CommandOrControl+Shift+K', 'darwin')).toBe('Cmd+Shift+K')
    expect(shortcutLabel('CmdOrCtrl+K', 'linux')).toBe('Ctrl+K')
  })

  it('keeps a custom chord token for token and in its own order', () => {
    expect(shortcutLabel('Ctrl+Shift+K', 'darwin')).toBe('Ctrl+Shift+K')
    expect(shortcutLabel('Super+F9', 'linux')).toBe('Super+F9')
    expect(shortcutLabel('Meta+F9', 'darwin')).toBe('Cmd+F9')
  })
})

describe('modifierLabel', () => {
  it('reads either spelling of a modifier, in any case', () => {
    expect(modifierLabel('command', 'darwin')).toBe('Cmd')
    expect(modifierLabel('CONTROL', 'win32')).toBe('Ctrl')
    expect(modifierLabel('Option', 'win32')).toBe('Alt')
    expect(modifierLabel('AltGr', 'linux')).toBe('AltGr')
  })

  it('returns a non-modifier key untouched', () => {
    expect(modifierLabel('Space', 'darwin')).toBe('Space')
  })
})
