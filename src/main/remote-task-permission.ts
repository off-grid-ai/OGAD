/** Pro owns paired-device consent. Core owns only this narrow policy port. */
export type RemoteTaskPermissionProvider = (deviceId: string) => boolean

let provider: RemoteTaskPermissionProvider | null = null

export function registerRemoteTaskPermissionProvider(
  next: RemoteTaskPermissionProvider | null
): void {
  provider = next
}

export function mayRunRemoteTask(deviceId: string): boolean {
  return provider?.(deviceId) === true
}
