/**
 * The Desktop received-media release seam.
 *
 * A generated image the user removes from the gallery is one of two things, and only one owner may
 * unlink each. A locally generated image's bytes belong to this repository's byte journal. An image
 * with remote provenance was written by the Shared File boundary, and its bytes stay that owner's
 * to remove — so the gallery does not touch them, it names them and asks.
 *
 * The seam is process-local and lives outside composition on purpose: `src` must not import `pro/`,
 * and the Pro Shared File service fills it while it is running.
 */

/** The durable fact a restart needs once the metadata row is gone. */
export type GeneratedImageReleaseIntent = {
  /** The canonical gallery id. For remote-provenance records this IS the Shared File `syncId`. */
  readonly id: string
  /** The path the canonical record held. Never used to unlink here; it names the bytes. */
  readonly path: string
  /** The durable gallery deletion operation that alone may settle these bytes. */
  readonly operationId: string
}

/**
 * What the Shared File owner can honestly answer.
 *
 * - `settled` — the owner acted; the bytes are gone.
 * - `already_settled` — settled absence: no record, and the confined file is PROVEN missing. The
 *   only honest way for a caller to end a retry.
 * - `failed` — ownership or absence is not proven, or owner I/O failed. The caller must retry.
 */
export type GeneratedImageReleaseOutcome =
  | { readonly status: 'settled' }
  | { readonly status: 'already_settled' }
  | { readonly status: 'failed'; readonly message: string }

export type DesktopReceivedMediaRelease = (
  intent: GeneratedImageReleaseIntent
) => Promise<GeneratedImageReleaseOutcome>

let activeRelease: DesktopReceivedMediaRelease | null = null

/** Install the running Shared File owner. Returns the matching uninstall. */
export function registerDesktopReceivedMediaRelease(
  release: DesktopReceivedMediaRelease
): () => void {
  activeRelease = release
  return () => {
    if (activeRelease === release) activeRelease = null
  }
}

/**
 * The owner, or `null` when no Pro Shared File session is running.
 *
 * A missing owner is NOT a settled release: the caller must keep its intent durable and fail.
 */
export function desktopReceivedMediaRelease(): DesktopReceivedMediaRelease | null {
  return activeRelease
}
