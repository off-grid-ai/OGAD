// External links out of the app. Kept in one place so a URL change is a single
// edit and cross-sell surfaces stay consistent. These open in the user's browser
// via window.api.openExternal (never in-app).

/** The main marketing site. */
export const OFF_GRID_WEBSITE_URL = 'https://getoffgridai.co'

/** Off Grid AI Mobile landing page — carries both App Store and Google Play links.
 *  Mirrors mobile's link to getoffgridai.co/desktop. */
export const OFF_GRID_MOBILE_URL = 'https://getoffgridai.co/mobile'

/** Open a URL in the user's default browser through the required preload bridge. */
export function openExternal(url: string): void {
  window.api.openExternal(url)
}
