import { CATALOG, primaryFileName, type CatalogEntry } from '@offgrid/models'

export interface DesktopImageRuntimeIdentityPort {
  resolve(modelId: string, entry?: CatalogEntry): string
}

/**
 * The single Desktop adapter from Shared's canonical image-model identity to the native runtime
 * identity. Shared owns catalog identity and artifact roles. Desktop only projects that fact into
 * the filename expected by stable-diffusion.cpp; directory-backed runtimes keep the canonical id.
 */
export const desktopImageRuntimeIdentity: DesktopImageRuntimeIdentityPort = {
  resolve(modelId, suppliedEntry) {
    const entry = suppliedEntry ?? CATALOG.find((model) => model.id === modelId)
    if (!entry || entry.runtime === 'mflux') return modelId
    return primaryFileName(entry) ?? modelId
  }
}
