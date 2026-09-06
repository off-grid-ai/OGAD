/**
 * Hotkey parsing: the UI-TARS combo string -> nut.js Key member names, and a
 * fail-closed null on anything it does not recognise so the host never presses
 * a partial, wrong combination.
 */
import { describe, expect, it } from 'vitest'
import { hotkeyToKeyNames } from '../vision-keys'

describe('hotkeyToKeyNames', () => {
  it('maps modifiers + a letter', () => {
    expect(hotkeyToKeyNames('ctrl c')).toEqual(['LeftControl', 'C'])
    expect(hotkeyToKeyNames('cmd v')).toEqual(['LeftSuper', 'V'])
    expect(hotkeyToKeyNames('alt shift t')).toEqual(['LeftAlt', 'LeftShift', 'T'])
  })

  it('accepts + as a separator and normalizes case', () => {
    expect(hotkeyToKeyNames('Ctrl+Shift+A')).toEqual(['LeftControl', 'LeftShift', 'A'])
  })

  it('maps named keys, digits, and arrows', () => {
    expect(hotkeyToKeyNames('enter')).toEqual(['Enter'])
    expect(hotkeyToKeyNames('ctrl 1')).toEqual(['LeftControl', 'Num1'])
    expect(hotkeyToKeyNames('down')).toEqual(['Down'])
    expect(hotkeyToKeyNames('escape')).toEqual(['Escape'])
    expect(hotkeyToKeyNames('f12')).toEqual(['F12'])
    expect(hotkeyToKeyNames('home')).toEqual(['Home'])
    expect(hotkeyToKeyNames('pagedown')).toEqual(['PageDown'])
    expect(hotkeyToKeyNames(';')).toEqual(['Semicolon'])
  })

  it('fails closed on an empty or unrecognised combo', () => {
    expect(hotkeyToKeyNames('')).toBeNull()
    expect(hotkeyToKeyNames('   ')).toBeNull()
    // A partial combo with one junk token is refused entirely, not pressed half.
    expect(hotkeyToKeyNames('ctrl fnord')).toBeNull()
  })
})
