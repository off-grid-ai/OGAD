import { EventEmitter } from 'node:events'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow, Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { installMediaPermissionHandler } from '../media-permission'
import { setMainWindow } from '../main-window'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app', isPackaged: true } }))

type PermissionHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>

describe('renderer media permission admission', () => {
  it('registers once, admits media, and rejects unrelated renderer permissions (#15)', () => {
    let handler: PermissionHandler | null = null
    const setPermissionRequestHandler = (next: PermissionHandler | null): void => {
      handler = next
    }
    installMediaPermissionHandler({ setPermissionRequestHandler } as Pick<
      Session,
      'setPermissionRequestHandler'
    >)

    if (!handler) throw new Error('Permission handler was not registered')

    const decision = (
      permission: Parameters<PermissionHandler>[1],
      isMainFrame = true
    ): boolean => {
      let granted = false
      handler!({} as never, permission, (value) => (granted = value), { isMainFrame } as never)
      return granted
    }
    expect(decision('media')).toBe(true)
    expect(decision('notifications')).toBe(false)
    expect(decision('geolocation')).toBe(false)
    expect(decision('openExternal')).toBe(false)
  })

  // Release's stricter rule (media-permission.ts): full screen is the main window's own document
  // only, asked by its main frame from the page it is showing.
  it("lets the app's own page go full screen (a recording's video), but not an embedded frame", () => {
    const appPage = pathToFileURL(path.join('/app', 'out', 'renderer', 'index.html')).href
    const contents = Object.assign(new EventEmitter(), { getURL: () => `${appPage}#/meetings` })
    setMainWindow({ webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow)
    contents.emit('did-navigate', {}, appPage)
    let handler: PermissionHandler | null = null
    installMediaPermissionHandler({
      setPermissionRequestHandler: (next: PermissionHandler | null) => (handler = next)
    } as Pick<Session, 'setPermissionRequestHandler'>)
    const decision = (isMainFrame: boolean, from: unknown = contents): boolean => {
      let granted = false
      handler!(from as never, 'fullscreen', (value) => (granted = value), {
        isMainFrame,
        requestingUrl: contents.getURL()
      } as never)
      return granted
    }
    expect(decision(true)).toBe(true)
    expect(decision(false)).toBe(false)
    expect(decision(true, new EventEmitter())).toBe(false)
  })
})
