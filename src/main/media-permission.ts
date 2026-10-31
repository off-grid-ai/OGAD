import { app, type Session } from 'electron'
import { pathToFileURL } from 'node:url'
import { getMainWindow, getMainWindowDocumentUrl } from './main-window'
import { rendererHtmlPath } from './renderer-path'
import { fullscreenOriginAllowed } from './fullscreen-origin'

type PermissionSession = Pick<Session, 'setPermissionRequestHandler'>

/**
 * Admit renderer microphone/media requests and the app player's fullscreen requests while
 * rejecting unrelated Chromium permissions. macOS still owns the actual microphone grant
 * through TCC. The app's own UI may also write the clipboard (navigator.clipboard.writeText,
 * e.g. the artifact Copy button); a subframe such as an artifact preview may not.
 */
export function installMediaPermissionHandler(target: PermissionSession): void {
  target.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === 'clipboard-sanitized-write') {
      callback(details.isMainFrame)
      return
    }
    if (permission === 'media') {
      // macOS still owns the actual microphone grant through TCC.
      callback(true)
      return
    }
    if (
      permission === 'fullscreen' &&
      details.isMainFrame &&
      webContents === getMainWindow()?.webContents
    ) {
      const rendererUrl =
        !app.isPackaged && process.env.ELECTRON_RENDERER_URL
          ? process.env.ELECTRON_RENDERER_URL
          : pathToFileURL(rendererHtmlPath()).href
      callback(
        fullscreenOriginAllowed(
          rendererUrl,
          getMainWindowDocumentUrl() ?? '',
          webContents.getURL(),
          details.requestingUrl
        )
      )
      return
    }
    callback(false)
  })
}
