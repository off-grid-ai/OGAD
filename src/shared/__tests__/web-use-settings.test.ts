import { describe, expect, it } from 'vitest'
import { DEFAULT_WEB_USE_SETTINGS, normalizeWebUseSettings } from '../web-use-settings'

describe('normalizeWebUseSettings browserTarget', () => {
  it('defaults to the Off Grid AI browser', () => {
    expect(DEFAULT_WEB_USE_SETTINGS.browserTarget).toBe('in_app')
    expect(normalizeWebUseSettings(undefined).browserTarget).toBe('in_app')
  })

  it('keeps the default browser choice, and nothing else', () => {
    expect(normalizeWebUseSettings({ browserTarget: 'default_browser' }).browserTarget).toBe(
      'default_browser'
    )
    expect(normalizeWebUseSettings({ browserTarget: 'safari' }).browserTarget).toBe('in_app')
  })

  it('leaves the shared Computer Use fields as they were', () => {
    expect(normalizeWebUseSettings({ browserTarget: 'default_browser' }).modelStrategy).toBe(
      'same_as_chat'
    )
  })
})
