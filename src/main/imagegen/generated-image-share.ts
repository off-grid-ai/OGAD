import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describeGeneratedImage, readGeneratedImageMetadata } from '@offgrid/sync'
import type { ChatHome, SharedFileDescriptor } from '@offgrid/sync'
import { emitSharedFileMutation } from '../sync-shared-file'
import { readGeneratedImageSidecar, writeGeneratedImageSidecar } from './gallery-sidecar'

/**
 * Gather what this Mac knows about a generated image, then let the shared rule describe it.
 *
 * The split is the point. Reading a sidecar beside a PNG is this platform's business; deciding what
 * a generated image looks like on the wire is not. That decision lived here AND on the phone, and the
 * two copies had already disagreed about the name of the model field.
 */
export function describeOwnGeneratedImage(
  imagePath: string,
  shownIn?: ChatHome
): SharedFileDescriptor | null {
  const facts = readGeneratedImageSidecar(imagePath)
  if (!facts.syncId) return null
  const stat = fs.statSync(imagePath)
  const metadata = readGeneratedImageMetadata(facts.metadataJson)
  const recordedHome =
    facts.conversationId && facts.messageId
      ? { conversationId: facts.conversationId, messageId: facts.messageId }
      : undefined
  return describeGeneratedImage(
    {
      syncId: facts.syncId,
      name: path.basename(imagePath),
      fileSize: stat.size,
      createdAt: facts.createdAt ?? new Date(stat.mtimeMs).toISOString(),
      ...(facts.conversationId ? { conversationId: facts.conversationId } : {}),
      ...(facts.width === undefined ? {} : { width: facts.width }),
      ...(facts.height === undefined ? {} : { height: facts.height }),
      ...(metadata === undefined ? {} : { metadata })
    },
    shownIn ?? recordedHome
  )
}

/** Offer a generated image to the mesh. Returns whether it could be described at all. */
export function shareGeneratedImage(imagePath: string, shownIn?: ChatHome): boolean {
  let descriptor: SharedFileDescriptor | null = null
  try {
    descriptor = describeOwnGeneratedImage(imagePath, shownIn)
  } catch (error) {
    // A gallery entry can be deleted while this runs. Still said out loud: this also covers a file
    // that could not be read, which is worth knowing about.
    console.error(
      `[image-share] ${JSON.stringify({
        event: 'describe-threw',
        path: imagePath,
        error: error instanceof Error ? error.message : String(error)
      })}`
    )
    return false
  }
  if (!descriptor) {
    // Said out loud. Refusing in silence is indistinguishable from an image nobody generated, which
    // is exactly how a picture reached a phone's gallery and its chat drew a hole.
    console.error(`[image-share] ${JSON.stringify({ event: 'not-describable', path: imagePath })}`)
    return false
  }
  emitSharedFileMutation({ kind: 'put', filePath: imagePath, file: descriptor })
  return true
}

/**
 * Describe an image, giving it an identity first if it has never had one.
 *
 * For the images already on disk before the sidecar carried a syncId. The alternative - and what the
 * backfill used to do - is to mint a fresh id on the spot without writing it down, so the same
 * picture gets a different name on every scan and no peer can tell it from a new image. Assigning
 * once and recording it means the name survives.
 */
export function describeGeneratedImageEnsuringIdentity(
  imagePath: string
): SharedFileDescriptor | null {
  if (!readGeneratedImageSidecar(imagePath).syncId) {
    writeGeneratedImageSidecar(imagePath, { syncId: randomUUID() })
  }
  return describeOwnGeneratedImage(imagePath)
}

/**
 * Record that a generated image hangs under a chat message, and offer it again.
 *
 * The message does not exist when the image is made - the chat persists it afterwards - so the link
 * cannot be part of the first description. Re-offering the SAME syncId through the same door updates
 * the record every device already holds and re-delivers it, which is what lets the far side move the
 * picture out of the gallery and under the message.
 */
export function noteGeneratedImageMessage(link: ChatHome & { imagePath: string }): boolean {
  const current = readGeneratedImageSidecar(link.imagePath)
  const alreadyLinked =
    current.conversationId === link.conversationId && current.messageId === link.messageId
  writeGeneratedImageSidecar(link.imagePath, {
    conversationId: link.conversationId,
    messageId: link.messageId
  })
  if (alreadyLinked) return true
  return shareGeneratedImage(link.imagePath, {
    conversationId: link.conversationId,
    messageId: link.messageId
  })
}
