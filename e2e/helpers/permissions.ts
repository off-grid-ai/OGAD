import type { ElectronApplication } from '@playwright/test'

/**
 * Precondition guard for specs that assert the capture pipeline is RUNNING.
 *
 * Screen Recording is a macOS TCC grant the test cannot request or fake: it belongs to the
 * launched binary (the dev Electron.app or the packaged bundle) and the OS revokes it
 * periodically. When it is denied the product correctly renders its "Permission required"
 * state with a single "Review permissions" action, so a spec that expects Pause/Resume/Restart
 * would report a product regression that is really a host-permission state.
 *
 * Like the fixed-port guard in ./ports, the spec SKIPS with the reason instead of asserting
 * against a state it does not own. CI machines grant the binary up front, so they still run it.
 */
export const screenRecordingUnavailableReason = async (
  app: ElectronApplication
): Promise<string | null> => {
  if (process.platform !== 'darwin') return null
  const status = await app.evaluate(({ systemPreferences }) =>
    systemPreferences.getMediaAccessStatus('screen')
  )
  if (status === 'granted') return null
  return `macOS Screen Recording is "${status}" for the E2E Electron binary - grant it in System Settings › Privacy & Security › Screen Recording and re-run. Capture controls only render while capture is permitted.`
}
