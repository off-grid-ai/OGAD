import os from 'node:os'
import { CATALOG, ModelResidencyManager, inventoryModelMemoryProfile } from '@offgrid/models'

const MB = 1024 * 1024

/**
 * Precondition guard for journeys that need an image model ADMITTED into memory.
 *
 * The app admits a model through the shared ModelResidencyManager against the host's free memory
 * at that moment, and fails closed when it does not fit. After a long E2E run the Mac is often
 * short, and the tool-owned image path offers no "Run anyway" (see docs/GAPS_BACKLOG.md), so the
 * journey has no user path forward. Ask the same shared rule the app asks, with the same memory
 * snapshot, and skip with the reason instead of reporting the fail-closed behaviour as a defect.
 *
 * Size is the shared memory profile of the catalog artifact, the same projection the app builds its
 * model descriptor from, so the answer here is the answer the app gives.
 */
export const imageModelAdmissionUnavailableReason = (modelId: string): string | null => {
  const entry = CATALOG.find((model) => model.id === modelId)
  if (!entry) return `image model ${modelId} is not in the catalog`
  const artifactBytes = entry.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0)
  const profile = inventoryModelMemoryProfile({ artifactBytes, kind: entry.kind, remote: false })
  const sizeMB = profile.peakSizeMB ?? profile.residentSizeMB ?? artifactBytes / MB
  const memory = new ModelResidencyManager({
    current: () => ({
      totalMB: os.totalmem() / MB,
      availableMB: os.freemem() / MB,
      platform: 'desktop'
    })
  })
  if (memory.canLoadWithoutEviction({ key: `e2e:${modelId}`, sizeMB })) return null
  return `host has ${Math.round(os.freemem() / MB)} MB free; ${entry.name} needs about ${Math.round(sizeMB)} MB, so the app would refuse admission (fail-closed) and the tool-owned image path offers no Run anyway`
}
