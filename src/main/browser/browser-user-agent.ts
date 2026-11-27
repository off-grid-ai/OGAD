/**
 * A Chrome user agent without the Electron and app tokens. Sites (Google sign-in first) refuse or
 * downgrade a browser that names itself Electron, so the built-in browser says only what Chrome
 * on this computer would say.
 */
export function chromeUserAgent(fallback: string): string {
  // Electron puts "<app name>/<version>" between "(KHTML, like Gecko)" and "Chrome/", and the
  // app name can hold spaces, so the whole span goes.
  return fallback
    .replace(/\(KHTML, like Gecko\).*?(Chrome\/)/, '(KHTML, like Gecko) $1')
    .replace(/\s+Electron\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
