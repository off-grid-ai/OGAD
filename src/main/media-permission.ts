import type { Session } from 'electron'
import { is } from '@electron-toolkit/utils'
import { pathToFileURL } from 'node:url'
import { getMainWindow, getMainWindowDocumentUrl } from './main-window'
import { rendererHtmlPath } from './renderer-path'
import { fullscreenOriginAllowed } from './fullscreen-origin'

type PermissionSession = Pick<Session, 'setPermissionRequestHandler'>

/** Admit media and the app player's fullscreen requests. Other permissions stay denied. */
export function installMediaPermissionHandler(target: PermissionSession): void {
  target.setPermissionRequestHandler((webContents, permission, callback, details) => {
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
        is.dev && process.env.ELECTRON_RENDERER_URL
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
