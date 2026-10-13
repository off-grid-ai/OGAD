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
  if (/mmproj|clip/i.test(currentFile)) {
    return 'vision projector'
  }
  if (/(?:^|[-_.])d-?flash(?:[-_.]|$)/i.test(currentFile)) {
    return 'DFlash draft model'
  }
  return null
}

/** Recovery copy for model setup. Keep native diagnostics in the app log. */
export function modelSetupErrorMessage(error: string): string {
  if (/\b(EACCES|EPERM)\b|permission denied|read-only file system/i.test(error)) {
    return 'Cannot save the model. In Setup & health, choose a writable model folder, then retry.'
  }
  if (/\bENOSPC\b|no space left/i.test(error)) {
    return 'Not enough free space. Free some storage, then retry.'
  }
  if (/cancel(?:led|ed)/i.test(error)) return 'Download canceled.'
  if (/^(The setup plan changed\.|Select at least one model)/.test(error)) return error
  if (/\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b|fetch failed|network|HTTP \d{3}/i.test(error)) {
    return 'The download failed. Check your connection, then retry.'
  }
  return 'Could not set up the model. Try again. Technical details are in the app log.'
}
