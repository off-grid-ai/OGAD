export interface AuthenticatedTaskLaunch {
  launchId: string
  requestingDeviceId: string
}

const LAUNCH_ID_ARG = '__offgridTaskLaunchId'
const REQUESTING_DEVICE_ID_ARG = '__offgridTaskRequestingDeviceId'

export function actionArgsWithTaskLaunch(
  args: Record<string, unknown>,
  launch?: AuthenticatedTaskLaunch
): Record<string, unknown> {
  const clean = { ...args }
  delete clean[LAUNCH_ID_ARG]
  delete clean[REQUESTING_DEVICE_ID_ARG]
  return launch
    ? {
        ...clean,
        [LAUNCH_ID_ARG]: launch.launchId,
        [REQUESTING_DEVICE_ID_ARG]: launch.requestingDeviceId
      }
    : clean
}

export function taskLaunchFromActionArgs(args: unknown): AuthenticatedTaskLaunch | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const fields = args as Record<string, unknown>
  const launchId = typeof fields[LAUNCH_ID_ARG] === 'string' ? fields[LAUNCH_ID_ARG].trim() : ''
  const requestingDeviceId =
    typeof fields[REQUESTING_DEVICE_ID_ARG] === 'string'
      ? fields[REQUESTING_DEVICE_ID_ARG].trim()
      : ''
  return launchId && requestingDeviceId ? { launchId, requestingDeviceId } : null
}
