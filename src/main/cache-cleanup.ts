import { session } from 'electron'
import type { CacheCleanupResultContract } from '../shared/ipc-contracts'
import { desktopModels, modelsFailureMessage } from './composition/application-access'

async function measuredCacheSize(): Promise<number | null> {
  try {
    return await session.defaultSession.getCacheSize()
  } catch {
    return null
  }
}

export async function clearEphemeralCache(): Promise<CacheCleanupResultContract> {
  const before = await measuredCacheSize()
  // Electron's `cache` data type covers disposable network, CacheStorage, shared
  // dictionary, and shader caches. The explicit allowlist excludes cookies,
  // localStorage, IndexedDB, downloads, and every app-owned filesystem store.
  await session.defaultSession.clearData({ dataTypes: ['cache'] })
  const after = await measuredCacheSize()
  return {
    success: true,
    freedBytes: before == null || after == null ? null : Math.max(0, before - after),
    incompleteDownloadsRemoved: 0
  }
}

/** Clear disposable browser data and inactive model-download artifacts through their owners. */
export async function clearTemporaryStorage(): Promise<CacheCleanupResultContract> {
  const downloads = await desktopModels.clearInactiveDownloads()
  if (!downloads.ok) throw new Error(modelsFailureMessage(downloads.failure))

  const cache = await clearEphemeralCache()
  const knownFreedBytes = downloads.value.freedBytes + (cache.freedBytes ?? 0)
  return {
    success: true,
    freedBytes: cache.freedBytes == null && downloads.value.freedBytes === 0 ? null : knownFreedBytes,
    incompleteDownloadsRemoved: downloads.value.count
  }
}
