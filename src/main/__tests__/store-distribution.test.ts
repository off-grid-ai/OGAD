import { describe, expect, it } from 'vitest'
import {
  resolveStoreDistribution,
  storeAllowsDownloadedEngines,
  storeName
} from '../store-distribution'

describe('resolveStoreDistribution', () => {
  it('reads each store from the signal its runtime sets', () => {
    expect(resolveStoreDistribution({ mas: true })).toBe('mac-app-store')
    expect(resolveStoreDistribution({ windowsStore: true })).toBe('microsoft-store')
    expect(resolveStoreDistribution({ snap: '/snap/off-grid-ai/12' })).toBe('snap-store')
  })

  it('knows a Microsoft Store install by the WindowsApps folder it runs from', () => {
    expect(
      resolveStoreDistribution({
        execPath:
          'C:\\Program Files\\WindowsApps\\OffGridAI.Desktop_0.0.61.0_x64__abc\\app\\off-grid-ai.exe'
      })
    ).toBe('microsoft-store')
  })

  it('treats a direct download as self-updating', () => {
    expect(
      resolveStoreDistribution({
        execPath: 'C:\\Users\\Mac\\AppData\\Local\\Programs\\off-grid-ai\\off-grid-ai.exe'
      })
    ).toBeNull()
    expect(resolveStoreDistribution({})).toBeNull()
    expect(resolveStoreDistribution({ mas: false, windowsStore: false, snap: '' })).toBeNull()
  })

  it('names the store the way Settings shows it', () => {
    expect(storeName('microsoft-store')).toBe('the Microsoft Store')
    expect(storeName('snap-store')).toBe('the App Center')
  })

  it('keeps shipped engines in the Apple and Microsoft store builds', () => {
    expect(storeAllowsDownloadedEngines('mac-app-store')).toBe(false)
    expect(storeAllowsDownloadedEngines('microsoft-store')).toBe(false)
    expect(storeAllowsDownloadedEngines('snap-store')).toBe(true)
    expect(storeAllowsDownloadedEngines(null)).toBe(true)
  })
})
