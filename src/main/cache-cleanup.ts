// Temporary Storage clears disposable Chromium data and incomplete model transfers.
// Durable chats, projects, installed models, settings, and Pro data stay untouched.
import { session } from 'electron'
import { clearInactiveDownloads } from './models-manager'
import type { CacheCleanupResultContract } from '../shared/ipc-contracts'

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
  const downloads = await clearInactiveDownloads()
  if (!downloads.success) throw new Error('Incomplete model downloads could not be cleared')
  const cacheBytes = before == null || after == null ? null : Math.max(0, before - after)
  return {
    success: true,
    freedBytes:
      cacheBytes == null ? downloads.freedBytes || null : cacheBytes + downloads.freedBytes
  }
}
