import { runtimeBackendSnapshot } from './runtime-backends'
import type { PermissionStatusContract, SystemHealthContract } from '../shared/ipc-contracts'
import { llm } from './llm'
import { getPermissionStatus } from './permissions'
import { NATIVE_STEP_LABELS, nativeSteps, type NativeStep } from './native-step-guard'

interface IpcStatusRegistrar {
  handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => unknown
}

interface ChatHealthPublisher {
  publish: (health: SystemHealthContract['components'][number]) => void
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

/** The health row id for a native step, which `system:restart` takes to try the step again. */
export function nativeStepComponentId(step: NativeStep): string {
  return `native-step:${step}`
}

/** A step that crashed the app stays off; its row says so and offers a retry. */
function blockedNativeStepComponents(): SystemHealthContract['components'] {
  return nativeSteps()
    .blockedSteps()
    .map((step) => ({
      id: nativeStepComponentId(step),
      label: NATIVE_STEP_LABELS[step],
      status: 'down' as const,
      detail: 'Off since it closed the app. Restart to try again.',
      canRestart: true
    }))
}

/** Compose the runtime snapshot with the production TCC owner before it crosses
 * IPC. The renderer receives one immutable truth record and does no platform or
 * permission interpretation of its own. */
export async function getRenderedSystemHealth(): Promise<SystemHealthContract> {
  const [health, permissions] = await Promise.all([
    import('./setup').then((module) => module.getSystemHealth()),
    readPermissionComponents()
  ])
  return {
    ...health,
    components: [...health.components, ...permissions, ...blockedNativeStepComponents()]
  }
}

/** Narrow registration seam shared by Electron and the in-process integration
 * harness. The injectable value is ipcMain itself, an uncontrollable native
 * transport boundary; every Off Grid AI status owner above remains real. */
export function setupSystemStatusIpc(
  target: IpcStatusRegistrar,
  chatHealthPublisher?: ChatHealthPublisher
): void {
  target.handle('system:chat-health', () =>
    import('./setup').then((module) => module.getChatHealth())
  )
  target.handle('system:runtime-backends', () => [llm.runtimeBackend(), ...runtimeBackendSnapshot()])
  target.handle('system:health', () => getRenderedSystemHealth())
  target.handle('permissions:get-status', () => getPermissionStatus())

  if (chatHealthPublisher) {
    let revision = 0
    let lastPublished = ''
    llm.onHealthInvalidated(() => {
      const requestedRevision = ++revision
      void import('./setup')
        .then((module) => module.getChatHealth())
        .then((health) => {
          if (requestedRevision !== revision) return
          const serialized = JSON.stringify(health)
          if (serialized === lastPublished) return
          lastPublished = serialized
          chatHealthPublisher.publish(health)
        })
        .catch((error) => console.error('[system-health] chat refresh failed:', error))
    })
  }
}
