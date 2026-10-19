import type { Session } from 'electron'

type PermissionSession = Pick<Session, 'setPermissionRequestHandler'>

/**
 * Admit renderer microphone/media requests while rejecting unrelated Chromium
 * permissions. macOS still owns the actual microphone grant through TCC.
 * The app's own UI may also write the clipboard (navigator.clipboard.writeText, e.g. the
 * artifact Copy button); a subframe such as an artifact preview may not.
 */
export function installMediaPermissionHandler(target: PermissionSession): void {
  target.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission === 'clipboard-sanitized-write') {
      callback(details.isMainFrame)
      return
    }
    callback(permission === 'media')
  })
}
