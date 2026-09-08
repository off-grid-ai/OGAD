import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  createGeneratedImageRecord,
  type GeneratedImageGalleryFacade,
  type GeneratedImageRecord,
  type MessageRecord,
  type PortableMessageContentPart
} from '@offgrid/application'
import { isGeneratedImageFile } from '@offgrid/models'
import { readGeneratedImageMetadata } from '@offgrid/sync'
import sharp from 'sharp'
import { desktopWorkspaceContent } from '../composition/application-access'
import { dataDir } from '../runtime-env'
import { readGeneratedImageSidecar } from './gallery-sidecar'
import { resolveExistingOwnedEntry } from './owned-path'

interface MigrationRepository {
  migrationComplete(): boolean
  markMigrationComplete(): void
}

interface LegacyGalleryRecord {
  readonly record: GeneratedImageRecord
  readonly messageId?: string
  readonly byteIdentity: string
}

// Old sidecars could retain every generation fact except the model identifier. Preserve those
// images with an explicit unknown legacy origin instead of inventing a model or blocking the whole
// gallery migration.
const LEGACY_UNKNOWN_MODEL_ID = 'legacy:unknown'

async function contentIdentity(imagePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.promises.readFile(imagePath))
    .digest('hex')
}

function assertLegacyMessageRelation(
  imagePath: string,
  relation: { readonly messageId?: string; readonly conversationId?: string }
): void {
  if (relation.messageId && !relation.conversationId) {
    throw new Error(
      `Generated image ${path.basename(imagePath)} has a message without a conversation.`
    )
  }
}

async function legacyRecord(imagePath: string): Promise<LegacyGalleryRecord | null> {
  const sidecar = readGeneratedImageSidecar(imagePath)
  const generation = readGeneratedImageMetadata(sidecar.metadataJson)
  const image = await sharp(imagePath).metadata()
  const stat = await fs.promises.stat(imagePath)
  const byteIdentity = await contentIdentity(imagePath)
  const id = sidecar.syncId ?? byteIdentity
  const width = sidecar.width ?? image.width
  const height = sidecar.height ?? image.height
  assertLegacyMessageRelation(imagePath, sidecar)
  if (!generation?.prompt || !generation.steps || generation.seed === undefined) {
    console.warn(
      `[gallery-migration] preserving ${path.basename(imagePath)} on disk because its legacy generation facts are incomplete`
    )
    return null
  }
  if (!width || !height) {
    throw new Error(`Generated image ${path.basename(imagePath)} has no readable dimensions.`)
  }
  return {
    byteIdentity,
    record: createGeneratedImageRecord({
      id,
      ...(sidecar.conversationId === undefined ? {} : { conversationId: sidecar.conversationId }),
      prompt: generation.prompt,
      ...(generation.negativePrompt === undefined
        ? {}
        : { negativePrompt: generation.negativePrompt }),
      width,
      height,
      steps: generation.steps,
      seed: generation.seed,
      modelId: generation.modelId?.trim() || LEGACY_UNKNOWN_MODEL_ID,
      createdAt: sidecar.createdAt ?? stat.mtime.toISOString(),
      local: { path: imagePath, fileName: path.basename(imagePath) }
    }),
    ...(sidecar.messageId ? { messageId: sidecar.messageId } : {})
  }
}

function sameGeneration(left: LegacyGalleryRecord, right: LegacyGalleryRecord): boolean {
  return (
    left.byteIdentity === right.byteIdentity &&
    left.record.prompt === right.record.prompt &&
    left.record.negativePrompt === right.record.negativePrompt &&
    left.record.width === right.record.width &&
    left.record.height === right.record.height &&
    left.record.steps === right.record.steps &&
    left.record.seed === right.record.seed &&
    left.record.modelId === right.record.modelId
  )
}

function coalesceLegacyRecords(
  records: readonly LegacyGalleryRecord[]
): readonly LegacyGalleryRecord[] {
  const byId = new Map<string, LegacyGalleryRecord>()
  for (const item of records) {
    const current = byId.get(item.record.id)
    if (!current) {
      byId.set(item.record.id, item)
      continue
    }
    const relationsConflict =
      current.record.conversationId !== null &&
      item.record.conversationId !== null &&
      current.record.conversationId !== item.record.conversationId
    if (!sameGeneration(current, item) || relationsConflict) {
      throw new Error(`Generated image ${item.record.id} has conflicting legacy records.`)
    }
    if (current.record.conversationId === null && item.record.conversationId !== null) {
      byId.set(item.record.id, item)
    }
  }
  return [...byId.values()]
}

async function readLegacyRecords(): Promise<readonly LegacyGalleryRecord[]> {
  const directory = path.join(dataDir(), 'generated-images')
  let names: string[]
  try {
    names = await fs.promises.readdir(directory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
  const records = await Promise.all(
    names
      .filter((name) => isGeneratedImageFile(name) && !name.startsWith('preview-'))
      .sort((left, right) => left.localeCompare(right, 'en'))
      .flatMap((name) => {
        const imagePath = resolveExistingOwnedEntry(directory, name)
        return imagePath ? [legacyRecord(imagePath)] : []
      })
  )
  return records.filter((record): record is LegacyGalleryRecord => record !== null)
}

function imagePart(record: GeneratedImageRecord): PortableMessageContentPart {
  return {
    type: 'image',
    contentId: record.contentId,
    width: record.width,
    height: record.height,
    seed: record.seed
  }
}

function migratedContent(
  message: MessageRecord,
  record: GeneratedImageRecord
): MessageRecord['portable']['content'] {
  const current = message.portable.content
  if (typeof current === 'string') return [{ type: 'text', text: current }, imagePart(record)]
  const contentMatches = current.filter(
    (part) => 'contentId' in part && part.contentId === record.contentId
  )
  const legacyMatches = current.filter((part) => part.type === 'image' && part.id === record.id)
  if (
    contentMatches.length > 1 ||
    legacyMatches.length > 1 ||
    (contentMatches[0] && contentMatches[0].type !== 'image') ||
    (contentMatches[0] && legacyMatches[0] && contentMatches[0] !== legacyMatches[0])
  ) {
    throw new Error(`Message ${message.id} has a conflicting content identity ${record.contentId}.`)
  }
  if (contentMatches.length === 1) return current
  if (legacyMatches.length === 1) {
    return current.map((part) =>
      part === legacyMatches[0] ? { ...part, contentId: record.contentId } : part
    )
  }
  if (current.some((part) => part.type === 'image' && !part.contentId && !part.id)) {
    throw new Error(`Message ${message.id} has an image part without a transferable identity.`)
  }
  return [...current, imagePart(record)]
}

async function migrateMessageRelation(item: LegacyGalleryRecord): Promise<LegacyGalleryRecord> {
  if (!item.messageId) return item
  const snapshot = desktopWorkspaceContent.snapshot()
  if (snapshot.status !== 'ready') {
    throw new Error('Workspace Content is not ready for gallery migration.')
  }
  const message = snapshot.messages.find((candidate) => candidate.id === item.messageId)
  if (!message) {
    console.warn(
      `[gallery-migration] importing generated image ${item.record.id} without its missing legacy message ${item.messageId}`
    )
    return { ...item, record: { ...item.record, conversationId: null } }
  }
  if (message.conversationId !== item.record.conversationId) {
    throw new Error(`Generated image ${item.record.id} has a conflicting message conversation.`)
  }
  const content = migratedContent(message, item.record)
  if (content === message.portable.content) return item
  const outcome = await desktopWorkspaceContent.execute({
    type: 'update_message',
    origin: 'migration',
    messageId: message.id,
    portable: { ...message.portable, content }
  })
  if (!outcome.ok) throw new Error(outcome.failure.message)
  return item
}

/** Import the old sidecar inventory exactly once through Shared validation and conflict policy. */
export async function migrateGeneratedImageSidecars(input: {
  readonly repository: MigrationRepository
  readonly gallery: GeneratedImageGalleryFacade
}): Promise<void> {
  if (input.repository.migrationComplete()) return
  const legacy = coalesceLegacyRecords(await readLegacyRecords())
  const migrated = await Promise.all(legacy.map(migrateMessageRelation))
  const outcome = await input.gallery.importLegacy(migrated.map((item) => item.record))
  if (!outcome.ok) throw new Error(outcome.failure.message)
  input.repository.markMigrationComplete()
}
