import { describe, expect, it } from 'vitest'
import { browserFamily, pickBrowserLink } from '../web-use-target'

const link = (name: string): { browser: { name: string } } => ({ browser: { name } })

describe('browserFamily', () => {
  it('reads app names, ProgIds and extension device names alike', () => {
    expect(browserFamily('Brave Browser')).toBe('brave')
    expect(browserFamily('BraveHTML')).toBe('brave')
    expect(browserFamily('Microsoft Edge')).toBe('edge')
    expect(browserFamily('Google Chrome')).toBe('chrome')
    expect(browserFamily('Chromium extension')).toBe('chrome')
    expect(browserFamily('Firefox extension')).toBe('firefox')
    expect(browserFamily('Safari')).toBeNull()
    expect(browserFamily(null)).toBeNull()
  })
})

describe('pickBrowserLink', () => {
  const links = [link('Chrome extension'), link('Brave extension')]

  it('runs in-app unless the user chose the default browser', () => {
    expect(pickBrowserLink('in_app', links, 'Brave Browser')).toBeNull()
  })

  it('prefers the connected browser that is the default', () => {
    expect(pickBrowserLink('default_browser', links, 'Brave Browser')).toBe(links[1])
  })

  it('falls back to the newest connected browser, or in-app when none is connected', () => {
    expect(pickBrowserLink('default_browser', links, 'Safari')).toBe(links[0])
    expect(pickBrowserLink('default_browser', [], 'Brave Browser')).toBeNull()
  })
})
