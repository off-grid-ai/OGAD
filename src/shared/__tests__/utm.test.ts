import { describe, expect, it } from 'vitest'
import { withUtm } from '../utm'
import { PRO_PURCHASE_URL } from '../product-links'

const TAGS = 'utm_source=off-grid-desktop-app&utm_medium=upgrade-screen&utm_campaign=in-app'

describe('withUtm', () => {
  it('puts the tags before #buy so the website still scrolls to the buy section', () => {
    expect(withUtm(PRO_PURCHASE_URL, 'upgrade-screen')).toBe(
      `https://getoffgridai.co/pro/?${TAGS}#buy`
    )
  })

  it('adds a query to a link that has none', () => {
    expect(withUtm('https://getoffgridai.co/mobile', 'upgrade-screen')).toBe(
      `https://getoffgridai.co/mobile?${TAGS}`
    )
  })

  it('keeps an existing query and appends the tags to it', () => {
    expect(withUtm('https://getoffgridai.co/pro/?plan=once#buy', 'upgrade-screen')).toBe(
      `https://getoffgridai.co/pro/?plan=once&${TAGS}#buy`
    )
  })

  it('names the surface the link sits on as the medium', () => {
    expect(withUtm('https://getoffgridai.co', 'about-panel')).toContain('utm_medium=about-panel')
  })
})
