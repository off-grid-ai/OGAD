import type { Session } from 'electron'
import { is } from '@electron-toolkit/utils'
import { pathToFileURL } from 'node:url'
import { getMainWindow } from './main-window'
import { rendererHtmlPath } from './renderer-path'

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
      try {
        const expected = new URL(rendererUrl)
        const requester = new URL(details.requestingUrl)
        // Embedded sites share this session, but cannot enter fullscreen as the app.
        callback(
          expected.protocol === 'file:'
            ? requester.protocol === 'file:' && requester.pathname === expected.pathname
            : requester.origin === expected.origin
        )
        return
      } catch {
        /* Invalid URLs remain denied. */
      }
    }
    callback(false)
  })
}
