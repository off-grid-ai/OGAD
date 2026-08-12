import dgram from 'node:dgram'
import { systemPreferences, shell, desktopCapturer } from 'electron'
import type { PermissionStatusContract } from '../shared/ipc-contracts'

export type PermissionStatus = PermissionStatusContract
const MDNS_MULTICAST_HOST = '224.0.0.251'
const MDNS_PORT = 5353
const LOCAL_NETWORK_PROBE_TIMEOUT_MS = 1_000

/**
 * macOS does not expose Local Network TCC through Electron's systemPreferences API. Exercise the
 * same multicast route Bonjour needs instead. The empty DNS query is bounded and the socket owns
 * its error handler, so a denied route becomes setup state rather than an uncaught main-process
 * exception.
 */
async function checkLocalNetworkPermission(): Promise<boolean> {
  if (process.platform !== 'darwin') return true

  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    let settled = false
    const timeout = setTimeout(() => finish(false), LOCAL_NETWORK_PROBE_TIMEOUT_MS)
    timeout.unref()

    const finish = (granted: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.close()
      resolve(granted)
    }

    socket.once('error', () => finish(false))
    socket.send(Buffer.alloc(12), MDNS_PORT, MDNS_MULTICAST_HOST, (error) => finish(!error))
  })
}

/**
 * Check if the app has Accessibility permission on macOS.
 * This permission is required for global dictation input and text insertion.
 */
function checkAccessibilityPermission(prompt: boolean = false): boolean {
  if (process.platform !== 'darwin') {
    return true // Not applicable on other platforms
  }
  return systemPreferences.isTrustedAccessibilityClient(prompt)
}

/**
 * Check if the app has Screen Recording permission on macOS.
 * This permission is required for desktopCapturer to capture window screenshots.
 */
function checkScreenRecordingPermission(): boolean {
  if (process.platform !== 'darwin') {
    return true // Not applicable on other platforms
  }

  // On macOS, we check screen recording access via getMediaAccessStatus
  const status = systemPreferences.getMediaAccessStatus('screen')
  console.log('[permissions] Screen recording status:', status)
  return status === 'granted'
}

/**
 * Get the status of all required permissions.
 */
export async function getPermissionStatus(): Promise<PermissionStatus> {
  const accessibility = checkAccessibilityPermission(false)
  const screenRecording = checkScreenRecordingPermission()
  const localNetwork = await checkLocalNetworkPermission()

  console.log(
    '[permissions] Status check - Accessibility:',
    accessibility,
    'Screen Recording:',
    screenRecording,
    'Local Network:',
    localNetwork
  )

  return {
    accessibility,
    screenRecording,
    localNetwork,
    allGranted: accessibility && screenRecording && localNetwork
  }
}

/**
 * Request Accessibility permission (shows system prompt on macOS).
 * Returns current status - user must grant manually in System Preferences.
 */
export function requestAccessibilityPermission(): boolean {
  if (process.platform !== 'darwin') {
    return true
  }
  // Passing true triggers the system dialog if not already trusted
  return systemPreferences.isTrustedAccessibilityClient(true)
}

/**
 * Open System Preferences to the appropriate pane for granting permissions.
 */
export function openAccessibilitySettings(): void {
  if (process.platform === 'darwin') {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    )
  }
}

export function openScreenRecordingSettings(): void {
  if (process.platform === 'darwin') {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
  }
}

export function openMicrophoneSettings(): void {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
  }
}

export function openLocalNetworkSettings(): void {
  if (process.platform === 'darwin') {
    // macOS 26 ignores the undocumented Privacy_LocalNetwork anchor and opens the parent page.
    // Open that supported destination intentionally; the setup card tells the user which row to
    // select instead of promising a deep link the OS does not honor.
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security')
  }
}

/**
 * Trigger the screen recording permission prompt by attempting to use desktopCapturer.
 * This will cause macOS to add the app to the Screen Recording list.
 */
export async function requestScreenRecordingPermission(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return true
  }

  try {
    // Attempting to get sources triggers the permission prompt
    // macOS will then add the app to the Screen Recording permissions list
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })

    // Check if permission was granted
    const status = systemPreferences.getMediaAccessStatus('screen')
    return status === 'granted'
  } catch (e) {
    console.error('Failed to request screen recording permission:', e)
    return false
  }
}
