import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What the app is allowed to do on this Mac, and how it finds out.
 *
 * Three permissions, and only two of them can be asked about directly. Local Network has no TCC API in
 * Electron, so it is inferred by exercising the same multicast route Bonjour needs - which means the
 * interesting cases here are the ways that probe can fail: refused, errored, or silent. A probe that threw
 * would take the main process down during setup; one that hung would leave the Setup screen spinning
 * forever. Both are covered.
 *
 * macOS itself is the boundary: systemPreferences, shell and desktopCapturer are faked, as is the UDP
 * socket. The platform branching, the composition and the failure handling are real.
 */

const electron = vi.hoisted(() => ({
  isTrustedAccessibilityClient: vi.fn(),
  getMediaAccessStatus: vi.fn(),
  openExternal: vi.fn(),
  getSources: vi.fn()
}))

vi.mock('electron', () => ({
  systemPreferences: {
    isTrustedAccessibilityClient: electron.isTrustedAccessibilityClient,
    getMediaAccessStatus: electron.getMediaAccessStatus
  },
  shell: { openExternal: electron.openExternal },
  desktopCapturer: { getSources: electron.getSources }
}))

// The multicast probe, faked at the socket. Each test decides how the send resolves: delivered, refused
// with an error argument, an 'error' event on the socket, or nothing at all.
const socket = vi.hoisted(() => ({
  behaviour: 'delivered' as 'delivered' | 'send-error' | 'socket-error' | 'silent',
  closed: false
}))

vi.mock('node:dgram', () => ({
  default: {
    createSocket: () => {
      const handlers = new Map<string, (error?: Error) => void>()
      return {
        once: (event: string, handler: (error?: Error) => void) => {
          handlers.set(event, handler)
          if (event === 'error' && socket.behaviour === 'socket-error') {
            setTimeout(() => handler(new Error('sendto failed: no route')), 0)
          }
        },
        send: (
          _message: Buffer,
          _port: number,
          _host: string,
          callback: (error: Error | null) => void
        ) => {
          if (socket.behaviour === 'delivered') setTimeout(() => callback(null), 0)
          if (socket.behaviour === 'send-error') {
            setTimeout(() => callback(new Error('operation not permitted')), 0)
          }
          // 'silent' and 'socket-error' never call back - the timeout or the error event decides.
        },
        close: () => {
          socket.closed = true
        }
      }
    }
  }
}))

const onPlatform = (platform: string): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('reading this machine-s permissions', () => {
  const realPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    socket.behaviour = 'delivered'
    socket.closed = false
    electron.isTrustedAccessibilityClient.mockReturnValue(true)
    electron.getMediaAccessStatus.mockReturnValue('granted')
    onPlatform('darwin')
  })

  afterEach(() => {
    onPlatform(realPlatform)
    vi.useRealTimers()
  })

  it('reports all three granted when macOS says yes and the multicast route works', async () => {
    const { getPermissionStatus } = await import('../permissions')

    await expect(getPermissionStatus()).resolves.toEqual({
      accessibility: true,
      screenRecording: true,
      localNetwork: true,
      allGranted: true
    })
  })

  it('asks about accessibility WITHOUT prompting, so a status check never raises a dialog', async () => {
    const { getPermissionStatus } = await import('../permissions')

    await getPermissionStatus()

    // A background status read must not put a system dialog in front of the user. Prompting is a separate,
    // explicit action - see requestAccessibilityPermission.
    expect(electron.isTrustedAccessibilityClient).toHaveBeenCalledWith(false)
  })

  it('treats screen recording as granted only when macOS says exactly that', async () => {
    const { getPermissionStatus } = await import('../permissions')

    for (const status of ['denied', 'restricted', 'not-determined', 'unknown']) {
      electron.getMediaAccessStatus.mockReturnValue(status)
      await expect(getPermissionStatus()).resolves.toMatchObject({ screenRecording: false })
    }
    electron.getMediaAccessStatus.mockReturnValue('granted')
    await expect(getPermissionStatus()).resolves.toMatchObject({ screenRecording: true })
  })

  it('says allGranted only when every one of them is granted', async () => {
    const { getPermissionStatus } = await import('../permissions')

    electron.isTrustedAccessibilityClient.mockReturnValue(false)
    await expect(getPermissionStatus()).resolves.toMatchObject({
      accessibility: false,
      allGranted: false
    })

    electron.isTrustedAccessibilityClient.mockReturnValue(true)
    socket.behaviour = 'send-error'
    await expect(getPermissionStatus()).resolves.toMatchObject({
      localNetwork: false,
      allGranted: false
    })
  })

  describe('the local network probe', () => {
    it('reads a refused send as permission denied', async () => {
      socket.behaviour = 'send-error'
      const { getPermissionStatus } = await import('../permissions')

      // What a denied Local Network permission actually looks like: the send fails rather than any API
      // saying so.
      await expect(getPermissionStatus()).resolves.toMatchObject({ localNetwork: false })
    })

    it('reads a socket error as permission denied, rather than crashing the main process', async () => {
      socket.behaviour = 'socket-error'
      const { getPermissionStatus } = await import('../permissions')

      // An unhandled 'error' on a dgram socket is an uncaught exception in main - the app would die during
      // setup, which is the least recoverable moment there is.
      await expect(getPermissionStatus()).resolves.toMatchObject({ localNetwork: false })
    })

    it('gives up after a second rather than leaving setup waiting for an answer', async () => {
      vi.useFakeTimers()
      socket.behaviour = 'silent'
      const { getPermissionStatus } = await import('../permissions')

      const pending = getPermissionStatus()
      await vi.advanceTimersByTimeAsync(1_000)

      // Multicast can simply go nowhere - no error, no reply. Without the bound, the Setup screen would
      // spin for ever on a machine that is merely on a network with no mDNS.
      await expect(pending).resolves.toMatchObject({ localNetwork: false })
    })

    it('closes the socket whichever way the probe ends', async () => {
      const { getPermissionStatus } = await import('../permissions')

      for (const behaviour of ['delivered', 'send-error'] as const) {
        socket.behaviour = behaviour
        socket.closed = false
        await getPermissionStatus()
        // A probe runs on every status read - the Setup screen polls it. Leaking a descriptor each time
        // would exhaust them over a long session.
        expect(socket.closed).toBe(true)
      }
    })
  })

  describe('on a platform without macOS TCC', () => {
    beforeEach(() => onPlatform('linux'))

    it('grants everything rather than blocking features that need no permission there', async () => {
      const { getPermissionStatus } = await import('../permissions')

      await expect(getPermissionStatus()).resolves.toEqual({
        accessibility: true,
        screenRecording: true,
        localNetwork: true,
        allGranted: true
      })
      // And it never calls the macOS-only APIs, which do not exist off darwin.
      expect(electron.isTrustedAccessibilityClient).not.toHaveBeenCalled()
      expect(electron.getMediaAccessStatus).not.toHaveBeenCalled()
    })

    it('opens no settings pane, because there is none to open', async () => {
      const permissions = await import('../permissions')

      permissions.openAccessibilitySettings()
      permissions.openScreenRecordingSettings()
      permissions.openMicrophoneSettings()
      permissions.openLocalNetworkSettings()

      expect(electron.openExternal).not.toHaveBeenCalled()
    })

    it('reports accessibility and screen recording as available without asking', async () => {
      const permissions = await import('../permissions')

      expect(permissions.requestAccessibilityPermission()).toBe(true)
      await expect(permissions.requestScreenRecordingPermission()).resolves.toBe(true)
      expect(electron.getSources).not.toHaveBeenCalled()
    })
  })

  describe('asking the user for a permission', () => {
    it('prompts for accessibility, which is what makes the dialog appear', async () => {
      electron.isTrustedAccessibilityClient.mockReturnValue(false)
      const { requestAccessibilityPermission } = await import('../permissions')

      expect(requestAccessibilityPermission()).toBe(false)
      // true is the whole point here: it is the argument that raises the system dialog.
      expect(electron.isTrustedAccessibilityClient).toHaveBeenCalledWith(true)
    })

    it('touches desktopCapturer to get the app listed under Screen Recording', async () => {
      electron.getSources.mockResolvedValue([])
      const { requestScreenRecordingPermission } = await import('../permissions')

      await expect(requestScreenRecordingPermission()).resolves.toBe(true)
      // A one-pixel thumbnail: the call exists to make macOS add the app to the list, not to capture
      // anything, so it asks for the least it can.
      expect(electron.getSources).toHaveBeenCalledWith({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }
      })
    })

    it('reports not-granted when the capture attempt is refused, without throwing at the caller', async () => {
      electron.getSources.mockRejectedValue(new Error('not authorised'))
      const { requestScreenRecordingPermission } = await import('../permissions')

      // The refusal IS the answer. Throwing would turn a normal "user said no" into an error the Setup
      // screen has to handle separately.
      await expect(requestScreenRecordingPermission()).resolves.toBe(false)
      expect(console.error).toHaveBeenCalled()
    })

    it('reports not-granted when the prompt was shown but access still is not given', async () => {
      electron.getSources.mockResolvedValue([])
      electron.getMediaAccessStatus.mockReturnValue('denied')
      const { requestScreenRecordingPermission } = await import('../permissions')

      // The listing succeeded and the user has not (yet) flipped the switch. Reading the status afterwards
      // rather than assuming success is what keeps the Setup card honest.
      await expect(requestScreenRecordingPermission()).resolves.toBe(false)
    })
  })

  describe('sending the user to the right settings pane', () => {
    it.each([
      [
        'openAccessibilitySettings',
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      ],
      [
        'openScreenRecordingSettings',
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      ],
      [
        'openMicrophoneSettings',
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      ]
    ])('%s opens its own anchor', async (name, url) => {
      const permissions = (await import('../permissions')) as unknown as Record<string, () => void>

      permissions[name]!()

      expect(electron.openExternal).toHaveBeenCalledWith(url)
    })

    it('opens the parent privacy page for Local Network, not an anchor macOS ignores', async () => {
      const { openLocalNetworkSettings } = await import('../permissions')

      openLocalNetworkSettings()

      // macOS 26 ignores the undocumented Privacy_LocalNetwork anchor and lands on the parent page anyway.
      // Asking for the supported destination is honest; the setup card names the row to look for.
      expect(electron.openExternal).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security'
      )
    })
  })
})
