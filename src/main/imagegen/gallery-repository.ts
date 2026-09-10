import { randomUUID } from 'node:crypto'
import {
  type GeneratedImageGalleryFacade,
  type GeneratedImageGalleryRepositoryPort,
  type GeneratedImageRecord
} from '@offgrid/application'
import type Database from 'better-sqlite3-multiple-ciphers'
import { applicationMutationAdmission } from '../mutation-admission'
import {
  ownedImagePath,
  quarantineAndReleaseOwnedBytes,
  releaseProvenanceBytes,
  type ByteDeletionFence,
  type ByteDeletionRow
} from './gallery-byte-release'
import { GeneratedImageCreationIntentRepository } from './creation-intent-repository'
import { registerGeneratedImageCreationIntents } from './creation-intent-runtime'
import { byteOwnerKind, type ByteOwnerKind } from './gallery-byte-owner'
import { createGeneratedImageGallerySchema, readGeneratedImageGalleryState } from './gallery-schema'

export { migrateGeneratedImageSidecars } from './gallery-migration'

const MIGRATION_ID = 'desktop-generated-image-sidecars-v1'
const DELETE_BYTE_RELEASE_RECEIPT =
  'DELETE FROM generated_image_byte_release_receipts WHERE image_id = ?'
let activeGallery: GeneratedImageGalleryFacade | null = null
let activeRepository: DesktopGeneratedImageGalleryRepository | null = null

/** Process-local read/command seam for native gallery byte adapters. */
export function registerDesktopGeneratedImageGallery(
  gallery: GeneratedImageGalleryFacade,
  repository?: DesktopGeneratedImageGalleryRepository
): () => void {
  activeGallery = gallery
  activeRepository = repository ?? null
  const releaseCreationIntents = registerGeneratedImageCreationIntents(repository?.creationIntents)
  return () => {
    if (activeGallery === gallery) activeGallery = null
    if (activeRepository === repository) activeRepository = null
    releaseCreationIntents()
  }
}

export function desktopGeneratedImageGallery(): GeneratedImageGalleryFacade {
  if (!activeGallery) throw new Error('Desktop generated-image gallery is not initialized.')
  const gallery = activeGallery
  return new Proxy(gallery, {
    get: (_target, property) => {
      if (property === 'create') {
        return (record: GeneratedImageRecord) =>
          applicationMutationAdmission.admit('images', () => gallery.create(record))
      }
      const value = gallery[property as keyof GeneratedImageGalleryFacade]
      return typeof value === 'function' ? value.bind(gallery) : value
    }
  })
}

export type DesktopGeneratedImageRemovalOutcome =
  | { readonly status: 'settled' | 'already_settled' }
  | { readonly status: 'failed'; readonly message: string }

/** Remove one canonical row and settle only the byte intent created for that identity. */
export async function removeDesktopGeneratedImage(
  imageId: string
): Promise<DesktopGeneratedImageRemovalOutcome> {
  if (!activeRepository) {
    return { status: 'failed', message: 'Desktop generated-image repository is not initialized.' }
  }
  const scope = `gallery:${imageId}`
  try {
    activeRepository.captureByteDeletionScope(scope, [imageId], randomUUID())
  } catch (cause) {
    return { status: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
  }
  const removal = await desktopGeneratedImageGallery().remove(imageId)
  if (!removal.ok && removal.failure.kind !== 'not_found') {
    return { status: 'failed', message: removal.failure.message }
  }
  try {
    await activeRepository.settleByteDeletionsForScope(scope)
    return { status: removal.ok ? 'settled' : 'already_settled' }
  } catch (cause) {
    return { status: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Retry every durable byte release, including intents admitted before a restart. */
export async function settleDesktopGeneratedImageReleases(): Promise<void> {
  if (!activeRepository) throw new Error('Desktop generated-image repository is not initialized.')
  await activeRepository.settleByteDeletions()
}

/** Durable Desktop storage mechanics for the Shared generated-image gallery owner. */
export class DesktopGeneratedImageGalleryRepository implements GeneratedImageGalleryRepositoryPort {
  private readonly settlements = new Map<string, Promise<void | 'fenced'>>()
  private readonly removalFences = new Map<string, () => boolean>()
  readonly creationIntents: GeneratedImageCreationIntentRepository

  constructor(private readonly db: Database.Database) {
    createGeneratedImageGallerySchema(db)
    this.creationIntents = new GeneratedImageCreationIntentRepository(db)
  }

  async read(): Promise<{ revision: string; images: readonly GeneratedImageRecord[] }> {
    const current = readGeneratedImageGalleryState(this.db)
    return {
      revision: String(current.revision),
      images: JSON.parse(current.images_json) as GeneratedImageRecord[]
    }
  }

  async replace(input: {
    readonly expectedRevision: string
    readonly images: readonly GeneratedImageRecord[]
  }): Promise<boolean> {
    return this.db.transaction(() => {
      const current = readGeneratedImageGalleryState(this.db)
      if (current.revision !== Number(input.expectedRevision)) return false
      const currentImages = JSON.parse(current.images_json) as GeneratedImageRecord[]
      const currentConversationByImageId = new Map(
        currentImages.map((image) => [image.id, image.conversationId] as const)
      )
      const conversationExists = this.db.prepare(
        `SELECT 1 FROM workspace_content_conversations c
         WHERE c.id = ? AND NOT EXISTS (
           SELECT 1 FROM workspace_content_conversation_deletion_intents d
           WHERE d.conversation_id = c.id AND d.state != 'completed'
         )`
      )
      const fenced = input.images.find(
        (image) =>
          image.conversationId &&
          currentConversationByImageId.get(image.id) !== image.conversationId &&
          !conversationExists.get(image.conversationId)
      )
      if (fenced?.conversationId) {
        throw new Error(`Conversation ${fenced.conversationId} is missing or being deleted.`)
      }
      const retained = new Set(input.images.map((image) => image.id))
      // EVERY removed record gets an intent, provenance included. The intent records WHICH owner
      // may act, so the metadata row and the durable knowledge of its bytes leave together. A
      // remote-provenance path is stored verbatim - it is the Shared File owner's to confine, and
      // it is never resolved against this app's generated-image library.
      const removed = currentImages
        .filter((image) => !retained.has(image.id))
        .map((image) => ({
          id: image.id,
          path: image.provenance ? image.local.path : ownedImagePath(image.local.path),
          owner: (image.provenance ? 'provenance' : 'local') satisfies ByteOwnerKind
        }))
      if (removed.some((image) => this.removalFences.get(image.id)?.() === false)) return false
      const result = this.db
        .prepare(
          `UPDATE generated_image_gallery_state
           SET revision = revision + 1, images_json = ?
           WHERE singleton = 1 AND revision = ?`
        )
        .run(JSON.stringify(input.images), current.revision)
      if (result.changes !== 1) return false
      const enqueue = this.db.prepare(
        `INSERT INTO generated_image_byte_deletions
          (image_id, deletion_operation_id, image_path, owner_kind)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(image_id, deletion_operation_id) DO NOTHING`
      )
      for (const image of removed) {
        const operations = this.db
          .prepare(
            `SELECT deletion_operation_id FROM generated_image_release_waiters
                    WHERE image_id = ? ORDER BY deletion_operation_id`
          )
          .all(image.id) as Array<{ deletion_operation_id: string }>
        for (const operation of operations) {
          enqueue.run(image.id, operation.deletion_operation_id, image.path, image.owner)
        }
      }
      for (const image of input.images) {
        this.db.prepare(DELETE_BYTE_RELEASE_RECEIPT).run(image.id)
        this.creationIntents.settleAdmitted(image.id, image.local.path)
      }
      return true
    })()
  }

  /** Keep the Shared winner predicate attached until a gallery removal commits or fails. */
  async withRemovalFence<Result>(input: {
    readonly imageId: string
    readonly isCurrentWinner: () => boolean
    readonly work: () => Promise<Result>
  }): Promise<Result> {
    const { imageId, isCurrentWinner, work } = input
    if (this.removalFences.has(imageId)) {
      throw new Error(`A gallery removal fence already owns image ${imageId}.`)
    }
    this.removalFences.set(imageId, isCurrentWinner)
    try {
      return await work()
    } finally {
      if (this.removalFences.get(imageId) === isCurrentWinner) {
        this.removalFences.delete(imageId)
      }
    }
  }

  /** Add one durable waiter for each captured canonical row or existing release intent. */
  captureByteDeletionScope(
    scope: string,
    imageIds: readonly string[],
    deletionOperationId = `scope:${scope}`
  ): void {
    if (!scope.trim()) throw new Error('A generated-image release scope is required.')
    if (!deletionOperationId.trim())
      throw new Error('A generated-image deletion operation is required.')
    this.db.transaction(() => {
      const images = new Set(
        (
          JSON.parse(readGeneratedImageGalleryState(this.db).images_json) as GeneratedImageRecord[]
        ).map((image) => image.id)
      )
      const capture = this.db.prepare(
        `INSERT OR IGNORE INTO generated_image_release_waiters
          (release_scope, image_id, deletion_operation_id) VALUES (?, ?, ?)`
      )
      const intents = new Set(
        (
          this.db.prepare('SELECT image_id FROM generated_image_byte_deletions').all() as Array<{
            image_id: string
          }>
        ).map(({ image_id }) => image_id)
      )
      for (const imageId of [...new Set(imageIds)].sort((left, right) =>
        left.localeCompare(right, 'en')
      )) {
        if (images.has(imageId) || intents.has(imageId))
          capture.run(scope, imageId, deletionOperationId)
      }
    })()
  }

  /**
   * Drain the durable release intents, each through the owner its row names.
   *
   * Nothing here decides ownership; the transaction that removed the metadata already did. A
   * failure - including no Shared File owner running - leaves the row intact with its path and
   * owner kind, and propagates, so the deletion workflow that awaits this retries the whole phase.
   */
  async settleByteDeletions(): Promise<void> {
    await this.settleRows(
      this.db
        .prepare(
          `SELECT image_id, deletion_operation_id, image_path, owner_kind, quarantine_path
           FROM generated_image_byte_deletions ORDER BY image_id ASC, deletion_operation_id ASC`
        )
        .all() as ByteDeletionRow[]
    )
  }

  /** Drain only the release rows created for one Shared deletion workflow. */
  async settleByteDeletionsForScope(
    scope: string,
    commitFence?: ByteDeletionFence
  ): Promise<void | 'fenced'> {
    if (commitFence && 'operationId' in commitFence) {
      const provisional = `scope:${scope}`
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO generated_image_byte_deletions
          (image_id, deletion_operation_id, image_path, attempt_count, last_error, owner_kind)
          SELECT image_id, ?, image_path, attempt_count, last_error, owner_kind
          FROM generated_image_byte_deletions WHERE deletion_operation_id = ?`
          )
          .run(commitFence.operationId, provisional)
        this.db
          .prepare(
            `INSERT OR IGNORE INTO generated_image_release_waiters
          (release_scope, image_id, deletion_operation_id)
          SELECT release_scope, image_id, ? FROM generated_image_release_waiters
          WHERE release_scope = ? AND deletion_operation_id = ?`
          )
          .run(commitFence.operationId, scope, provisional)
        this.db
          .prepare(
            `DELETE FROM generated_image_release_waiters
          WHERE release_scope = ? AND deletion_operation_id = ?`
          )
          .run(scope, provisional)
        this.db
          .prepare(
            `DELETE FROM generated_image_byte_deletions
          WHERE deletion_operation_id = ? AND NOT EXISTS (
            SELECT 1 FROM generated_image_release_waiters waiter
            WHERE waiter.image_id = generated_image_byte_deletions.image_id
              AND waiter.deletion_operation_id = generated_image_byte_deletions.deletion_operation_id
          )`
          )
          .run(provisional)
      })()
    }
    return this.settleRows(
      this.db
        .prepare(
          `SELECT intent.image_id, intent.deletion_operation_id, intent.image_path, intent.owner_kind,
                  intent.quarantine_path
           FROM generated_image_byte_deletions intent
           JOIN generated_image_release_waiters waiter
             ON waiter.image_id = intent.image_id
            AND waiter.deletion_operation_id = intent.deletion_operation_id
           WHERE waiter.release_scope = ? ORDER BY intent.image_id ASC`
        )
        .all(scope) as ByteDeletionRow[],
      commitFence
    )
  }

  private async settleRows(
    rows: readonly ByteDeletionRow[],
    commitFence?: ByteDeletionFence
  ): Promise<void | 'fenced'> {
    for (const row of rows) {
      if (commitFence && !commitFence()) return 'fenced'
      const result = await this.settleRow(row, commitFence)
      if (result === 'fenced') return result
    }
  }

  private settleRow(
    row: ByteDeletionRow,
    commitFence?: ByteDeletionFence
  ): Promise<void | 'fenced'> {
    const key = `${row.image_id}\u0000${row.deletion_operation_id}`
    const active = this.settlements.get(key)
    if (active) return active
    const settlement = this.performSettlement(row, commitFence).finally(() => {
      if (this.settlements.get(key) === settlement) this.settlements.delete(key)
    })
    this.settlements.set(key, settlement)
    return settlement
  }

  private async performSettlement(
    row: ByteDeletionRow,
    commitFence?: ByteDeletionFence
  ): Promise<void | 'fenced'> {
    try {
      if (commitFence && !commitFence()) return 'fenced'
      const current = (
        JSON.parse(readGeneratedImageGalleryState(this.db).images_json) as GeneratedImageRecord[]
      ).find((image) => image.id === row.image_id)
      if (current?.local.path === row.image_path) {
        this.db.transaction(() => {
          this.db
            .prepare(
              `DELETE FROM generated_image_release_waiters
            WHERE image_id = ? AND deletion_operation_id = ?`
            )
            .run(row.image_id, row.deletion_operation_id)
          this.db
            .prepare(
              `DELETE FROM generated_image_byte_deletions
            WHERE image_id = ? AND deletion_operation_id = ?`
            )
            .run(row.image_id, row.deletion_operation_id)
        })()
        return
      }
      const owner = byteOwnerKind(row.owner_kind, row.image_id)
      if (owner === 'provenance') {
        await releaseProvenanceBytes({
          id: row.image_id,
          path: row.image_path,
          operationId: row.deletion_operation_id
        })
      } else {
        await quarantineAndReleaseOwnedBytes(this.db, row, commitFence)
      }
      if (commitFence && !commitFence()) return 'fenced'
      const replacement = (
        JSON.parse(readGeneratedImageGalleryState(this.db).images_json) as GeneratedImageRecord[]
      ).find((image) => image.id === row.image_id)
      this.db.transaction(() => {
        if (!replacement) {
          this.db
            .prepare(
              `INSERT INTO generated_image_byte_release_receipts
          (image_id, deletion_operation_id, image_path) VALUES (?, ?, ?)
          ON CONFLICT(image_id, deletion_operation_id) DO UPDATE SET image_path = excluded.image_path`
            )
            .run(row.image_id, row.deletion_operation_id, row.image_path)
        }
        this.db
          .prepare(
            `DELETE FROM generated_image_release_waiters
                    WHERE image_id = ? AND deletion_operation_id = ?`
          )
          .run(row.image_id, row.deletion_operation_id)
        this.db
          .prepare(
            `DELETE FROM generated_image_byte_deletions
                    WHERE image_id = ? AND deletion_operation_id = ?`
          )
          .run(row.image_id, row.deletion_operation_id)
      })()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.db
        .prepare(
          `UPDATE generated_image_byte_deletions
           SET attempt_count = attempt_count + 1, last_error = ?
           WHERE image_id = ? AND deletion_operation_id = ?`
        )
        .run(message, row.image_id, row.deletion_operation_id)
      throw cause
    }
  }

  migrationComplete(): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM generated_image_gallery_migrations WHERE migration_id = ?')
        .get(MIGRATION_ID)
    )
  }

  markMigrationComplete(): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO generated_image_gallery_migrations(migration_id, completed_at)
         VALUES (?, ?)`
      )
      .run(MIGRATION_ID, new Date().toISOString())
  }
}
