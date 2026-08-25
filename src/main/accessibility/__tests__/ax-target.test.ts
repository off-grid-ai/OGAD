/**
 * The accessibility rail drives one NAMED app, so it picks the app the goal
 * names among those running - never the frontmost (which is Off Grid the moment
 * the user approves), never itself.
 */
import { describe, expect, it } from 'vitest'
import { pickTargetApp } from '../ax-target'

const SELF = 'Off Grid AI Desktop'

describe('pickTargetApp', () => {
  it('targets the running app the goal names', () => {
    expect(pickTargetApp('message sidd on Slack', ['Slack', 'Finder', SELF], SELF)).toBe('Slack')
  })

  it('is case-insensitive on both the goal and the app name', () => {
    expect(pickTargetApp('open the SLACK dm', ['Slack'], SELF)).toBe('Slack')
    expect(pickTargetApp('send it in slack', ['slack'], SELF)).toBe('slack')
  })

  it('never targets Off Grid itself even when the goal says the name', () => {
    expect(pickTargetApp('type this into Off Grid AI Desktop', [SELF], SELF)).toBeNull()
  })

  it('prefers the longest-named match (most specific app)', () => {
    // Both substrings are present; the more specific app wins.
    const running = ['Notes', 'Notesnook']
    expect(pickTargetApp('add to my Notesnook page', running, SELF)).toBe('Notesnook')
  })

  it('returns null when the goal names no running app (falls through to vision)', () => {
    expect(pickTargetApp('send 123.zip to sidd', ['Slack', 'Finder'], SELF)).toBeNull()
  })

  it('ignores one-letter app names that would match almost anything', () => {
    expect(pickTargetApp('do a thing', ['X'], SELF)).toBeNull()
  })

  it('trims and skips blank running-app entries', () => {
    expect(pickTargetApp('use Slack now', ['  Slack  ', '', '   '], SELF)).toBe('Slack')
  })
})
