/**
 * UTM tags for links from the desktop app to our own website (getoffgridai.co), so the site
 * can tell desktop visitors and buyers from "direct" traffic and see which surface sent them.
 * Same format as the phone app (mobile/src/utils/utm.ts), with the desktop source:
 *
 *   utm_source   = off-grid-desktop-app   (always: the visit came from this app)
 *   utm_medium   = <surface>              (where the link sits: upgrade-screen, about-panel, ...)
 *   utm_campaign = in-app
 *
 * Do not tag links to third parties (GitHub, Chrome Web Store) or pages the app fetches itself.
 */
const UTM_SOURCE = 'off-grid-desktop-app'
const UTM_CAMPAIGN = 'in-app'

/** Where a website link sits in the desktop app. Becomes `utm_medium`. */
export type UtmSurface =
  | 'about-panel'
  | 'license'
  | 'mobile-nav'
  | 'upgrade-screen'
  | 'upgrade-mobile'
  | 'upgrade-website'
  | 'onboarding-guide'

/** `url` with the desktop UTM tags in its query, before any `#fragment`. */
export function withUtm(url: string, surface: UtmSurface): string {
  const params = `utm_source=${UTM_SOURCE}&utm_medium=${surface}&utm_campaign=${UTM_CAMPAIGN}`
  const hashIdx = url.indexOf('#')
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url
  const fragment = hashIdx >= 0 ? url.slice(hashIdx) : ''
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}${params}${fragment}`
}
