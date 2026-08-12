import fs from 'node:fs'

/**
 * Everything known about a generated image apart from its bytes.
 *
 * ONE shape with ONE writer. Two existed: the generator wrote `{conversationId, projectId}` and the
 * sync receiver wrote `{syncId, conversationId, metadataJson}`, so what an image was called on the
 * mesh depended on which side of the wire produced it. An image generated here therefore had no
 * mesh identity at all, and the only way the chat could name its picture was an absolute path that
 * exists on exactly one machine.
 *
 * `syncId` is that identity. A generated image is the same image on every device, so the chat can
 * ask for it by name instead of by path, and a peer can put it back under the right message.
 */
export interface GeneratedImageSidecar {
  /** Mesh identity. Absent on images made before the sidecar carried one. */
  syncId?: string
  conversationId?: string
  projectId?: string | null
  /** The message this image hangs under, once the chat has persisted one. */
  messageId?: string
  /**
   * The app's own copy of the image this one was generated FROM, for an img2img turn.
   *
   * A copy, not the path the user picked. The picked file is theirs - on a Desktop, in a Downloads
   * folder - and it can be moved or deleted the moment the generation finishes, which left no record
   * at all of what "convert this into light mode" was converting.
   */
  initImage?: string
  /** When the image was made, in the one wire format. */
  createdAt?: string
  width?: number
  height?: number
  /** Canonical generation parameters, as they travel on the wire. */
  metadataJson?: string
}

/** The sidecar for an image, beside the image. */
export function generatedImageSidecarPath(imagePath: string): string {
  return `${imagePath}.json`
}

/** What the sidecar says, or nothing. A missing or unreadable sidecar is not an error: images
 *  predate it, and a gallery entry can be deleted while a scan is walking it. */
export function readGeneratedImageSidecar(imagePath: string): GeneratedImageSidecar {
  try {
    const raw = JSON.parse(
      fs.readFileSync(generatedImageSidecarPath(imagePath), 'utf8')
    ) as unknown
    if (!raw || typeof raw !== 'object') return {}
    const record = raw as Record<string, unknown>
    return {
      ...(typeof record.syncId === 'string' ? { syncId: record.syncId } : {}),
      ...(typeof record.conversationId === 'string'
        ? { conversationId: record.conversationId }
        : {}),
      ...(typeof record.projectId === 'string' || record.projectId === null
        ? { projectId: record.projectId as string | null }
        : {}),
      ...(typeof record.messageId === 'string' ? { messageId: record.messageId } : {}),
      ...(typeof record.initImage === 'string' ? { initImage: record.initImage } : {}),
      ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
      ...(typeof record.width === 'number' ? { width: record.width } : {}),
      ...(typeof record.height === 'number' ? { height: record.height } : {}),
      ...(typeof record.metadataJson === 'string' ? { metadataJson: record.metadataJson } : {})
    }
  } catch {
    return {}
  }
}

/**
 * Merge facts into the sidecar and promote it atomically.
 *
 * Merged, not replaced: the scope is saved after the image already has a `syncId`, and a write that
 * replaced the file would drop the identity the mesh had just given it. Promoted by rename so a
 * reader never sees a half-written sidecar and decides the image has no identity.
 */
export function writeGeneratedImageSidecar(
  imagePath: string,
  facts: GeneratedImageSidecar
): void {
  const sidecar = generatedImageSidecarPath(imagePath)
  const temporary = `${sidecar}.tmp`
  const merged: GeneratedImageSidecar = { ...readGeneratedImageSidecar(imagePath), ...facts }
  try {
    fs.writeFileSync(temporary, JSON.stringify(merged))
    fs.renameSync(temporary, sidecar)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}
