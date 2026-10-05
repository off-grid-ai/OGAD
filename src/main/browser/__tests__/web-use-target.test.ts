import { describe, expect, it } from 'vitest'
import { BROWSER_ORIGIN_PREFIX } from '../../extension-bridge/bridge-conversations'
import { browserFamily, pickBrowserLink, pickRequestingLink } from '../web-use-target'

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

describe('pickRequestingLink', () => {
  const links = [{ browser: { id: 'b1' } }, { browser: { id: 'b2' } }]
  const offered = (id: string): boolean => id === 'b2'

  it("runs a browser chat's task in that browser when it offered its tab", () => {
    expect(pickRequestingLink(`${BROWSER_ORIGIN_PREFIX}b2`, links, offered)).toBe(links[1])
  })

  it('leaves every other task to the Web Use setting', () => {
    expect(pickRequestingLink(`${BROWSER_ORIGIN_PREFIX}b1`, links, offered)).toBeNull()
    expect(pickRequestingLink('chat-123', links, offered)).toBeNull()
    expect(pickRequestingLink(`${BROWSER_ORIGIN_PREFIX}b3`, links, () => true)).toBeNull()
  })
})
