// Which store installed this copy, if any. A store install is updated by its store:
// the app must not download or swap its own bundle there (store policy, and the
// store's sandbox would refuse the swap anyway).
//
// Electron marks the Mac App Store build (process.mas) and the Windows MSIX
// package (process.windowsStore). snapd sets SNAP for every process in a snap.
// A Microsoft Store app always runs from Windows' WindowsApps folder, so that path counts too: a Store
// copy that ran its own updater saved our installer into the Store sandbox, and Windows refused to open
// it ("Error launching installer").

export type StoreDistribution = 'mac-app-store' | 'microsoft-store' | 'snap-store'

export interface StoreDistributionSignals {
  mas?: boolean
  windowsStore?: boolean
  snap?: string
  /** The running executable's path. */
  execPath?: string
}

const WINDOWS_APPS_FOLDER = /[\\/]WindowsApps[\\/]/i

export function resolveStoreDistribution(
  signals: StoreDistributionSignals
): StoreDistribution | null {
  if (signals.mas) return 'mac-app-store'
  if (signals.windowsStore || (signals.execPath && WINDOWS_APPS_FOLDER.test(signals.execPath)))
    return 'microsoft-store'
  if (signals.snap) return 'snap-store'
  return null
}

export function storeDistribution(): StoreDistribution | null {
  return resolveStoreDistribution({
    mas: process.mas,
    windowsStore: process.windowsStore,
    snap: process.env.SNAP,
    execPath: process.platform === 'win32' ? process.execPath : undefined
  })
}

// Apple (App Review 2.5.2) and Microsoft (Store policy 10.2.2) refuse apps that download
// and run new native code. Their builds keep the engines they shipped with; the store
// update brings newer ones. A snap may run code from its own data folder.
export function storeAllowsDownloadedEngines(store: StoreDistribution | null): boolean {
  return store !== 'mac-app-store' && store !== 'microsoft-store'
}

const STORE_NAMES: Record<StoreDistribution, string> = {
  'mac-app-store': 'the Mac App Store',
  'microsoft-store': 'the Microsoft Store',
  'snap-store': 'the App Center'
}

export function storeName(store: StoreDistribution): string {
  return STORE_NAMES[store]
}
