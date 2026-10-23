// External links out of the app. Kept in one place so a URL change is a single
// edit and cross-sell surfaces stay consistent. These open in the user's browser
// via window.api.openExternal (never in-app).

/** The main marketing site. */
export const OFF_GRID_WEBSITE_URL = 'https://getoffgridai.co'

/** Official Desktop installers for repairing or updating the app package. */
export const OFF_GRID_DESKTOP_RELEASES_URL = 'https://github.com/off-grid-ai/OGAD/releases'

/** Off Grid AI Mobile landing page — carries both App Store and Google Play links.
 *  Mirrors mobile's link to getoffgridai.co/desktop. */
export const OFF_GRID_MOBILE_URL = 'https://getoffgridai.co/mobile'

/** Open a URL in the user's default browser (falls back to window.open). */
export function openExternal(url: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).api
  if (api?.openExternal) api.openExternal(url)
  else window.open(url, '_blank')
}
