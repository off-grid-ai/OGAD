/**
 * The only runtime that may own desktop Sync. The legacy SyncService startup is gone, so
 * 'application' is the whole set: a second claim is a composition mistake, not a second product.
 */
export type DesktopSyncRuntimeOwner = 'application'

let activeOwner: DesktopSyncRuntimeOwner | null = null

/**
 * One process may bind one Sync runtime. The lease is independent of boot order, so entitlement
 * recovery, normal Pro activation, and shutdown cannot race two listeners onto the same port.
 */
export function claimDesktopSyncRuntime(owner: DesktopSyncRuntimeOwner): () => void {
  if (activeOwner) {
    throw new Error(`Desktop Sync is already owned by the ${activeOwner} runtime.`)
  }
  activeOwner = owner
  let released = false
  return () => {
    if (released) return
    released = true
    if (activeOwner === owner) activeOwner = null
  }
}

export function desktopSyncRuntimeOwner(): DesktopSyncRuntimeOwner | null {
  return activeOwner
}
