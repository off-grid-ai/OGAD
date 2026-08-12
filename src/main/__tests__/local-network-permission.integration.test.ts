import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  sendError: null as NodeJS.ErrnoException | null,
  openedUrl: '',
  closeCount: 0
}))

vi.mock('electron', () => ({
  systemPreferences: {
    isTrustedAccessibilityClient: () => true,
    getMediaAccessStatus: () => 'granted'
  },
  shell: {
    openExternal: async (url: string) => {
      boundary.openedUrl = url
    }
  },
  desktopCapturer: { getSources: async () => [] }
}))

vi.mock('node:dgram', () => ({
  default: {
    createSocket: () => ({
      once: () => undefined,
      send: (
        _message: Buffer,
        _port: number,
        _host: string,
        callback: (error: NodeJS.ErrnoException | null) => void
      ) => callback(boundary.sendError),
      close: () => {
        boundary.closeCount += 1
      }
    })
  }
}))

import { getPermissionStatus, openLocalNetworkSettings } from '../permissions'

beforeEach(() => {
  boundary.sendError = null
  boundary.openedUrl = ''
  boundary.closeCount = 0
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
})

afterEach(() => vi.restoreAllMocks())

describe('Local Network permission boundary', () => {
  it('reports the multicast route as granted and closes the probe socket', async () => {
    await expect(getPermissionStatus()).resolves.toEqual({
      accessibility: true,
      screenRecording: true,
      localNetwork: true,
      allGranted: true
    })
    expect(boundary.closeCount).toBe(1)
  })

  it('turns EHOSTUNREACH into setup state instead of an uncaught exception', async () => {
    boundary.sendError = Object.assign(new Error('send EHOSTUNREACH 224.0.0.251:5353'), {
      code: 'EHOSTUNREACH'
    })

    await expect(getPermissionStatus()).resolves.toEqual({
      accessibility: true,
      screenRecording: true,
      localNetwork: false,
      allGranted: false
    })
    expect(boundary.closeCount).toBe(1)
  })

  it('opens the supported macOS Privacy & Security page', () => {
    openLocalNetworkSettings()
    expect(boundary.openedUrl).toBe('x-apple.systempreferences:com.apple.preference.security')
  })
})
