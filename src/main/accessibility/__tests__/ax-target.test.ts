/**
 * The accessibility rail drives one NAMED app, so it picks the app the goal
 * names among those running - never the frontmost (which is Off Grid the moment
 * the user approves), never itself.
 */
import { describe, expect, it } from 'vitest'
import { pickTargetApp, pickWebTarget, isWebGoal } from '../ax-target'

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

describe('isWebGoal', () => {
  it('is true for goals about a web page / video', () => {
    expect(isWebGoal('click the first Family Guy video to play it')).toBe(true)
    expect(isWebGoal('open the first result on the page')).toBe(true)
    expect(isWebGoal('play the top result on YouTube')).toBe(true)
  })

  it('is false for a non-web app goal (so it is not hijacked to a browser)', () => {
    expect(isWebGoal('click the send button')).toBe(false)
    expect(isWebGoal('add a reminder to call mom')).toBe(false)
  })
})

describe('pickWebTarget (browser fallback for the orchestrator chain)', () => {
  it('still prefers the app the goal names', () => {
    expect(pickWebTarget('message sidd on Slack', ['Slack', 'Google Chrome', SELF], SELF)).toBe(
      'Slack'
    )
  })

  it('falls back to the running browser for a web goal that names no app', () => {
    // open_url just opened the browser; "click the first video" names nothing.
    expect(
      pickWebTarget('click the first Family Guy video to play it', ['Google Chrome', 'Finder'], SELF)
    ).toBe('Google Chrome')
  })

  it('prefers the higher-priority browser when several run', () => {
    expect(pickWebTarget('play the top video', ['Safari', 'Arc', 'Finder'], SELF)).toBe('Arc')
  })

  it('does NOT fall back to a browser for a non-web goal', () => {
    // "click send" means a chat app, not the running browser.
    expect(pickWebTarget('click send', ['Google Chrome', 'Slack'], SELF)).toBeNull()
  })

  it('returns null for a web goal when no browser is running', () => {
    expect(pickWebTarget('click the first video', ['Finder', 'Notes'], SELF)).toBeNull()
  })
})
