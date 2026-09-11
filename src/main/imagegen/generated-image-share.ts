import fs from 'node:fs'
import path from 'node:path'
import { describeGeneratedImage } from '@offgrid/sync'
import type { ChatHome, SharedFileDescriptor } from '@offgrid/sync'
import { desktopWorkspaceContent } from '../composition/application-access'
import { emitSharedFileMutation, type LocalSharedFileMutation } from '../sync-shared-file'
import { desktopGeneratedImageGallery } from './gallery-repository'
import { withCanonicalConversationWrite } from '../workspace-content/conversation-write-fence'
import { getDB } from '../database'
import { createHash } from 'node:crypto'

type PublicationRow = { image_id: string; mutation_json: string }
let activeDrain: Promise<boolean> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let publicationSuspensions = 0

function ensurePublicationSchema(): void {
  getDB().exec(`CREATE TABLE IF NOT EXISTS generated_image_publication_intents (
    image_id TEXT PRIMARY KEY CHECK (trim(image_id) <> ''),
    mutation_json TEXT NOT NULL CHECK (json_valid(mutation_json)),
    created_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS generated_image_publication_receipts (
    image_id TEXT PRIMARY KEY CHECK (trim(image_id) <> ''),
    mutation_sha256 TEXT NOT NULL,
    delivered_at TEXT NOT NULL
  )`)
}

function mutationFingerprint(mutation: LocalSharedFileMutation): string {
  return createHash('sha256').update(JSON.stringify(mutation)).digest('hex')
}

function enqueuePublication(mutation: Parameters<typeof emitSharedFileMutation>[0]): void {
  if (publicationSuspensions > 0) throw new Error('Image publication is suspended for deletion.')
  ensurePublicationSchema()
  getDB()
    .prepare(
      `INSERT INTO generated_image_publication_intents(image_id, mutation_json, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(image_id) DO UPDATE SET mutation_json = excluded.mutation_json,
         created_at = excluded.created_at, last_error = NULL`
    )
    .run(mutation.file.syncId, JSON.stringify(mutation), new Date().toISOString())
}

async function performPublicationDrain(): Promise<boolean> {
  ensurePublicationSchema()
  if (publicationSuspensions > 0) return false
  const rows = getDB()
    .prepare(
      `SELECT image_id, mutation_json FROM generated_image_publication_intents
       ORDER BY created_at ASC, image_id ASC`
    )
    .all() as PublicationRow[]
  for (const row of rows) {
    try {
      const mutation = JSON.parse(row.mutation_json) as Parameters<typeof emitSharedFileMutation>[0]
      if (!(await emitSharedFileMutation(mutation))) {
        throw new Error('The Shared File publication owner did not admit the image mutation.')
      }
      getDB().transaction(() => {
        getDB()
          .prepare(
            `INSERT INTO generated_image_publication_receipts(
               image_id, mutation_sha256, delivered_at
             ) VALUES (?, ?, ?)
             ON CONFLICT(image_id) DO UPDATE SET
               mutation_sha256 = excluded.mutation_sha256,
               delivered_at = excluded.delivered_at`
          )
          .run(row.image_id, mutationFingerprint(mutation), new Date().toISOString())
        getDB()
          .prepare('DELETE FROM generated_image_publication_intents WHERE image_id = ?')
          .run(row.image_id)
      })()
    } catch (cause) {
      getDB()
        .prepare(
          `UPDATE generated_image_publication_intents
           SET attempt_count = attempt_count + 1, last_error = ? WHERE image_id = ?`
        )
        .run(cause instanceof Error ? cause.message : String(cause), row.image_id)
      throw cause
    }
  }
  return true
}

/** Drain committed image announcements. A missing Pro owner leaves durable pending work. */
export function drainGeneratedImagePublicationIntents(): Promise<boolean> {
  if (activeDrain) return activeDrain
  const drain = performPublicationDrain()
    .catch((cause) => {
      if (!retryTimer && publicationSuspensions === 0) {
        retryTimer = setTimeout(() => {
          retryTimer = null
          void drainGeneratedImagePublicationIntents().catch((error) =>
            console.error('[image-share] publication retry failed', error)
          )
        }, 2_000)
      }
      throw cause
    })
    .finally(() => {
      if (activeDrain === drain) activeDrain = null
    })
  activeDrain = drain
  return drain
}

export function repairGeneratedImagePublicationIntents(): void {
  ensurePublicationSchema()
  const gallery = desktopGeneratedImageGallery().snapshot()
  if (gallery.status !== 'ready') throw new Error('Generated-image gallery is not ready.')
  for (const image of gallery.images) {
    const mutation = shareGeneratedImage(image.local.path)
    if (!mutation) continue
    const receipt = getDB()
      .prepare(
        `SELECT mutation_sha256 FROM generated_image_publication_receipts WHERE image_id = ?`
      )
      .get(image.id) as { mutation_sha256: string } | undefined
    if (receipt?.mutation_sha256 === mutationFingerprint(mutation)) continue
    if (!image.conversationId) continue
    withCanonicalConversationWrite(image.conversationId, () => {
      enqueuePublication(mutation)
      return { value: undefined }
    })
  }
}

export async function suspendGeneratedImagePublication(): Promise<void> {
  publicationSuspensions += 1
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  try {
    await activeDrain
  } catch {
    // The durable row is intentionally removed by the privacy owner after this drain stops.
  }
}

export function resumeGeneratedImagePublication(): void {
  publicationSuspensions = Math.max(0, publicationSuspensions - 1)
}

export function clearGeneratedImagePublicationState(): void {
  if (publicationSuspensions === 0) throw new Error('Image publication is not suspended.')
  ensurePublicationSchema()
  getDB().transaction(() => {
    getDB().prepare('DELETE FROM generated_image_publication_intents').run()
    getDB().prepare('DELETE FROM generated_image_publication_receipts').run()
  })()
}

/** Resolve the message that canonically owns one gallery content identity. */
function canonicalChatHome(contentId: string, conversationId: string | null): ChatHome | undefined {
  const workspace = desktopWorkspaceContent.snapshot()
  if (workspace.status !== 'ready') return undefined
  const messages = workspace.messages.filter((candidate) => {
    const content = candidate.portable.content
    return (
      Array.isArray(content) &&
      content.some((part) => part.type === 'image' && part.contentId === contentId)
    )
  })
  // A content identity without exactly one owning message is not a chat-home relation. Selecting
  // the first local row would make two devices publish different homes for the same image.
  const message = messages.length === 1 ? messages[0] : undefined
  if (message && conversationId !== null && message.conversationId !== conversationId) {
    return undefined
  }
  return message ? { conversationId: message.conversationId, messageId: message.id } : undefined
}

/**
 * Gather canonical gallery and Workspace Content facts, then let the shared rule describe them.
 *
 * The split is the point. Reading a sidecar beside a PNG is this platform's business; deciding what
 * a generated image looks like on the wire is not. That decision lived here AND on the phone, and the
 * two copies had already disagreed about the name of the model field.
 */
export function describeOwnGeneratedImage(imagePath: string): SharedFileDescriptor | null {
  const gallery = desktopGeneratedImageGallery().snapshot()
  const canonical =
    gallery.status === 'ready'
      ? gallery.images.find((image) => image.local.path === imagePath)
      : undefined
  if (!canonical) return null
  const stat = fs.statSync(imagePath)
  const recordedHome = canonicalChatHome(canonical.contentId, canonical.conversationId)
  return describeGeneratedImage(
    {
      syncId: canonical.id,
      name: canonical.local.fileName ?? path.basename(imagePath),
      fileSize: stat.size,
      createdAt: canonical.createdAt,
      ...(canonical.conversationId ? { conversationId: canonical.conversationId } : {}),
      width: canonical.width,
      height: canonical.height,
      metadata: {
        prompt: canonical.prompt,
        ...(canonical.negativePrompt === undefined
          ? {}
          : { negativePrompt: canonical.negativePrompt }),
        steps: canonical.steps,
        seed: canonical.seed,
        modelId: canonical.modelId
      }
    },
    recordedHome
  )
}

/** Offer a generated image to the mesh. Returns whether it could be described at all. */
export function shareGeneratedImage(imagePath: string): LocalSharedFileMutation | null {
  let descriptor: SharedFileDescriptor | null = null
  try {
    descriptor = describeOwnGeneratedImage(imagePath)
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
    return null
  }
  if (!descriptor) {
    // Said out loud. Refusing in silence is indistinguishable from an image nobody generated, which
    // is exactly how a picture reached a phone's gallery and its chat drew a hole.
    console.error(`[image-share] ${JSON.stringify({ event: 'not-describable', path: imagePath })}`)
    return null
  }
  return { kind: 'put', filePath: imagePath, file: descriptor }
}

/**
 * Compatibility entry point for scans: identity comes only from the canonical gallery.
 *
 * The startup importer reads old sidecars once and commits their normalized record. A live scan does
 * not mint an identity or write a compatibility mirror when that import has not completed.
 */
export function describeGeneratedImageEnsuringIdentity(
  imagePath: string
): SharedFileDescriptor | null {
  return describeOwnGeneratedImage(imagePath)
}

/**
 * Re-offer the generated image under the message that now owns its canonical content identity.
 *
 * The message does not exist when the image is made - the chat persists it afterwards - so the link
 * cannot be projected from Workspace Content in the first description. Re-offering the SAME
 * content identity after ChatSession commits the message updates every device without a sidecar
 * relationship mirror.
 */
export async function noteGeneratedImageMessage(
  link: ChatHome & { imagePath: string }
): Promise<boolean> {
  const gallery = desktopGeneratedImageGallery().snapshot()
  const image =
    gallery.status === 'ready'
      ? gallery.images.find((candidate) => candidate.local.path === link.imagePath)
      : undefined
  if (!image) return false
  const recordedHome = canonicalChatHome(image.contentId, image.conversationId)
  if (
    !recordedHome ||
    recordedHome.conversationId !== link.conversationId ||
    recordedHome.messageId !== link.messageId
  ) {
    return false
  }
  const mutation = shareGeneratedImage(link.imagePath)
  if (!mutation) return false
  withCanonicalConversationWrite(link.conversationId, () => {
    enqueuePublication(mutation)
    return { value: true }
  })
  await drainGeneratedImagePublicationIntents()
  return true
}
