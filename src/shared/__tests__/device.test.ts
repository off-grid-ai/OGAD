import { describe, it, expect } from 'vitest'
import { deviceNoun, isMac, primaryModifier } from '../device'

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
