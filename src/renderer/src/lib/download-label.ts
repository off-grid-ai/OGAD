import { isMMProjFile } from '@offgrid/models'

// A download can fetch just a COMPANION file (e.g. adding a vision projector to a model
// whose weights are already on disk — the downloader skips present files). Without a
// label that reads as a full re-download of the whole model. Turn the current filename
// into a human companion label so the UI can say what's actually downloading.

/** Human label for a companion file being fetched, or null for a primary-weights
 *  download (which needs no special label — it IS the model). */
export function companionDownloadLabel(currentFile?: string | null): string | null {
  if (!currentFile) {
    return null
  }
  if (isMMProjFile(currentFile)) {
    return 'vision projector'
  }
  return null
}
