import type { PermissionStatusContract, SystemHealthContract } from '../shared/ipc-contracts'
import { getPermissionStatus } from './permissions'

interface IpcStatusRegistrar {
  handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => unknown
}

function permissionComponents(
  permissions: PermissionStatusContract
): SystemHealthContract['components'] {
  return [
    {
      id: 'permission-accessibility',
      label: 'Accessibility permission',
      status: permissions.accessibility ? 'granted' : 'denied',
      detail: permissions.accessibility
        ? 'Capture and text insertion are allowed'
        : 'Grant access in System Settings'
    },
    {
      id: 'permission-screen-recording',
      label: 'Screen Recording permission',
      status: permissions.screenRecording ? 'granted' : 'denied',
      detail: permissions.screenRecording
        ? 'Screen capture is allowed'
        : 'Grant access in System Settings'
    },
    {
      id: 'permission-local-network',
      label: 'Local Network permission',
      status: permissions.localNetwork ? 'granted' : 'denied',
      detail: permissions.localNetwork
        ? 'Device discovery is allowed'
        : 'Grant access in System Settings'
    }
  ]
}

async function readPermissionComponents(): Promise<SystemHealthContract['components']> {
  try {
    return permissionComponents(await getPermissionStatus())
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return [
      {
        id: 'permission-accessibility',
        label: 'Accessibility permission',
        status: 'down',
        detail: `Permission status unavailable: ${reason}`
      },
      {
        id: 'permission-screen-recording',
        label: 'Screen Recording permission',
        status: 'down',
        detail: `Permission status unavailable: ${reason}`
      },
      {
        id: 'permission-local-network',
        label: 'Local Network permission',
        status: 'down',
        detail: `Permission status unavailable: ${reason}`
      }
    ]
  }
}

/** Compose the runtime snapshot with the production TCC owner before it crosses
 * IPC. The renderer receives one immutable truth record and does no platform or
 * permission interpretation of its own. */
export async function getRenderedSystemHealth(): Promise<SystemHealthContract> {
  const [health, permissions] = await Promise.all([
    import('./setup').then((module) => module.getSystemHealth()),
    readPermissionComponents()
  ])
  return { ...health, components: [...health.components, ...permissions] }
}

/** Narrow registration seam shared by Electron and the in-process integration
 * harness. The injectable value is ipcMain itself, an uncontrollable native
 * transport boundary; every Off Grid status owner above remains real. */
export function setupSystemStatusIpc(target: IpcStatusRegistrar): void {
  target.handle('system:health', () => getRenderedSystemHealth())
  target.handle('permissions:get-status', () => getPermissionStatus())
}
