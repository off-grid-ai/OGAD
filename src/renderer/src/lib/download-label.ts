import type { PublicDownloadInfo } from '@offgrid/application'

// A download can fetch just a COMPANION file (e.g. adding a vision projector to a model
// whose weights are already on disk). The owner supplies the current artifact role;
// a filename or model capability cannot tell the UI which artifact is moving.

/** Human label for a companion file being fetched, or null for a primary-weights
 *  download (which needs no special label — it IS the model). */
export function companionDownloadLabel(
  role?: PublicDownloadInfo['currentFileRole'] | null
): string | null {
  if (role === 'mmproj') {
    return 'Vision support (mmproj)'
  }
  return null
}
