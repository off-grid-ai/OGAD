import { isSetupRemoteConfigured, projectSetupReadiness } from '@offgrid/application'
import {
  desktopApplicationDegradation,
  desktopApplicationStatus,
  desktopSync,
  reportDesktopApplicationDegraded
} from './composition/application-access'
import { getRemoteVisionServerSettings } from './vision/remote-vision-server'
import type { ModelSetupStatusContract } from '../shared/ipc-contracts'

function readRemoteSetup(): { configured: boolean; failure: string | null } {
  let configured = false
  const failures: string[] = []
  try {
    for (const server of getRemoteVisionServerSettings().servers) {
      try {
        if (isSetupRemoteConfigured(server)) configured = true
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  const failure = failures.length ? failures.join('; ') : null
  reportDesktopApplicationDegraded({
    domain: 'models',
    source: 'setup.remote-configuration',
    reason: failure
  })
  return { configured, failure }
}

export function readDesktopSetupReadiness(
  downloaded: boolean,
  modelsDir: string
): ModelSetupStatusContract {
  const syncPaired = desktopSync.snapshot().paired.length > 0
  const remote = readRemoteSetup()
  const remoteRouteConfigured = remote.configured
  const syncFailure = desktopApplicationDegradation('sync', 'start')
  const lifecycle = desktopApplicationStatus()
  if (lifecycle === 'stopping' || lifecycle === 'stopped') {
    throw new Error('The application is stopped. Restart it to check your saved setup.')
  }
  if (!syncPaired && !downloaded && !remoteRouteConfigured && syncFailure) {
    throw new Error(`Setup could not read your Sync configuration: ${syncFailure.reason}`)
  }
  if (!syncPaired && !downloaded && !remoteRouteConfigured && remote.failure) {
    throw new Error(`Setup could not read your remote configuration: ${remote.failure}`)
  }
  return {
    downloaded,
    modelsDir,
    ...projectSetupReadiness({
      localModelAvailable: downloaded,
      remoteRouteConfigured,
      syncPaired,
      configurationLoaded: lifecycle === 'running'
    })
  }
}
