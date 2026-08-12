/**
 * How a chat message points at the generated image shown under it.
 *
 * The message used to hold `context.image`, an absolute path on the machine that made the picture.
 * That path is meaningless on every other device, so it was a third answer to a question the file
 * record already owned, and the two could not be kept in step: a peer received the message, found a
 * path it did not have, and drew a hole where the image should be.
 *
 * The reference carries BOTH: `id` is what the image is called on the mesh, and `path` is where its
 * bytes are on THIS device. Whoever materialises the bytes here writes the path; the id is what lets
 * it be found and repointed, which is exactly how the phone does it.
 */
export interface GeneratedImageReference {
  /** Mesh identity. Absent only on messages written before the reference carried one. */
  id?: string
  /** Where the bytes are on this device. */
  path: string
}

/**
 * Read the image reference out of a message's context blob, in either form.
 *
 * Tolerant on purpose. Rows written before this existed hold a bare `image` path and no identity;
 * they still render, and they are honestly reported as having no id rather than being given a
 * made-up one.
 */
export function readGeneratedImageReference(ctx: unknown): GeneratedImageReference | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined
  const record = ctx as Record<string, unknown>
  const reference = record.imageRef
  if (reference && typeof reference === 'object') {
    const candidate = reference as Record<string, unknown>
    if (typeof candidate.path === 'string' && candidate.path) {
      return {
        ...(typeof candidate.id === 'string' ? { id: candidate.id } : {}),
        path: candidate.path
      }
    }
  }
  // The legacy form: a path and nothing that names it.
  return typeof record.image === 'string' && record.image ? { path: record.image } : undefined
}

/** Put the reference into a context blob, dropping the legacy path so only one answer is stored. */
export function withGeneratedImageReference(
  ctx: Record<string, unknown> | undefined,
  reference: GeneratedImageReference
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(ctx ?? {}) }
  delete next.image
  next.imageRef = reference
  return next
}
