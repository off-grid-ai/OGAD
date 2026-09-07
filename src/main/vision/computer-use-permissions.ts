export interface ComputerUsePermissionState {
  platform: NodeJS.Platform
  accessibilityGranted: boolean
  screenRecordingGranted: boolean
}

/** Pure permission decision used before Computer Use loads a model or captures a frame. */
export function computerUsePermissionBlock(
  state: ComputerUsePermissionState
): string | null {
  if (state.platform !== 'darwin') return null
  const missing = [
    state.screenRecordingGranted ? null : 'Screen Recording',
    state.accessibilityGranted ? null : 'Accessibility'
  ].filter((permission): permission is string => permission !== null)
  if (missing.length === 0) return null
  return `Off Grid AI needs ${missing.join(' and ')} access for Computer Use. Grant it in System Settings > Privacy & Security, then run this task again.`
}
