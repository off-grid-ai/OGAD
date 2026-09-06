type NativeSurfaceOcclusionListener = (occluded: boolean) => void

let owners = 0
const listeners = new Set<NativeSurfaceOcclusionListener>()

function publish(): void {
  const occluded = owners > 0
  for (const listener of listeners) listener(occluded)
}

/**
 * Keep Electron native child views below renderer-owned modal surfaces.
 * Returns an idempotent release function so stacked panels restore the native
 * surface only after the last panel closes.
 */
export function acquireNativeSurfaceOcclusion(): () => void {
  owners += 1
  publish()
  let released = false
  return () => {
    if (released) return
    released = true
    owners = Math.max(0, owners - 1)
    publish()
  }
}

export function nativeSurfaceIsOccluded(): boolean {
  return owners > 0
}

export function onNativeSurfaceOcclusion(
  listener: NativeSurfaceOcclusionListener
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
