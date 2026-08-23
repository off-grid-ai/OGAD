import fs from 'node:fs'
import path from 'node:path'

interface KeychainRepairResult {
  status: 'healthy' | 'repaired' | 'unavailable' | 'failed'
  detail: string
  osStatus?: number | null
}

function helperCandidates(packaged: boolean): string[] {
  if (packaged) return [path.join(process.resourcesPath, 'bin', 'keychain-bootstrap.node')]
  return [
    path.join(process.cwd(), 'resources', 'bin', 'keychain-bootstrap.node'),
    path.join(__dirname, '../../resources/bin/keychain-bootstrap.node')
  ]
}

function describeNativeResult(value: unknown): KeychainRepairResult | null {
  if (!value || typeof value !== 'object') return null
  const result = value as { status?: unknown; osStatus?: unknown }
  const osStatus = typeof result.osStatus === 'number' ? result.osStatus : null
  switch (result.status) {
    case 0:
      return { status: 'healthy', detail: 'The user default Keychain is available.', osStatus }
    case 1:
      return {
        status: 'repaired',
        detail: 'The existing login Keychain was restored for Off Grid secure storage.',
        osStatus
      }
    case 2:
      return {
        status: 'unavailable',
        detail: 'The login Keychain is unavailable and was not changed.',
        osStatus
      }
    case 3:
      return {
        status: 'failed',
        detail: 'macOS refused to restore the existing login Keychain.',
        osStatus
      }
    default:
      return null
  }
}

/**
 * Restore only the observed macOS failure: no user-default Keychain registration,
 * while the existing login.keychain-db remains valid. The native bridge refuses
 * every other state and never creates, resets, unlocks, or deletes a Keychain.
 *
 * This must run before app.ready and before any safeStorage consumer. Electron's
 * macOS safeStorage bootstrap otherwise opens SecurityAgent's generic "Keychain
 * Not Found" dialog before Off Grid can explain or recover the problem.
 */
export function repairMissingDefaultKeychainAtBootstrap(
  platform: NodeJS.Platform,
  packaged: boolean
): KeychainRepairResult | null {
  if (platform !== 'darwin') return null
  const bindingPath = helperCandidates(packaged).find((candidate) => fs.existsSync(candidate))
  if (!bindingPath) {
    console.error('[secure-storage] Keychain recovery bridge is missing')
    return null
  }

  try {
    const nativeModule = { exports: {} } as NodeModule
    process.dlopen(nativeModule, bindingPath)
    const result = describeNativeResult(nativeModule.exports)
    if (!result) console.error('[secure-storage] Keychain recovery returned an invalid response')
    return result
  } catch (error) {
    console.error('[secure-storage] Keychain recovery failed', error)
    return null
  }
}
