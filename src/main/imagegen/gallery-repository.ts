import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  createGeneratedImageRecord,
  type DeletionCleanupContinuation,
  type GeneratedImageGalleryFacade,
  type GeneratedImageGalleryRepositoryPort,
  type GeneratedImageRecord,
  type MessageRecord,
  type PortableMessageContentPart
} from '@offgrid/application'
import { readGeneratedImageMetadata } from '@offgrid/sync'
import type Database from 'better-sqlite3-multiple-ciphers'
import sharp from 'sharp'
import { dataDir } from '../runtime-env'
import { isGeneratedImageFile } from '@offgrid/models'
import { generatedImageSidecarPath, readGeneratedImageSidecar } from './gallery-sidecar'
import { resolveExistingOwnedEntry, resolveExistingOwnedPath } from './owned-path'
import { desktopWorkspaceContent } from '../composition/application-access'
import { applicationMutationAdmission } from '../mutation-admission'
import {
  desktopReceivedMediaRelease,
  type GeneratedImageReleaseIntent
} from './generated-image-release'
import { GeneratedImageCreationIntentRepository } from './creation-intent-repository'
import { registerGeneratedImageCreationIntents } from './creation-intent-runtime'
import { byteOwnerKind, type ByteOwnerKind } from './gallery-byte-owner'

const MIGRATION_ID = 'desktop-generated-image-sidecars-v1'
const DELETE_BYTE_RELEASE_RECEIPT =
  'DELETE FROM generated_image_byte_release_receipts WHERE image_id = ?'
let activeGallery: GeneratedImageGalleryFacade | null = null
let activeRepository: DesktopGeneratedImageGalleryRepository | null = null

type StateRow = { revision: number; images_json: string }
type ByteDeletionRow = {
  image_id: string
  deletion_operation_id: string
  image_path: string
  owner_kind: string
  quarantine_path: string | null
}
type ByteDeletionFence = DeletionCleanupContinuation | (() => boolean)
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

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generated_image_gallery_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL,
      images_json TEXT NOT NULL
    );
    INSERT OR IGNORE INTO generated_image_gallery_state(singleton, revision, images_json)
    VALUES (1, 0, '[]');
    CREATE TABLE IF NOT EXISTS generated_image_gallery_migrations (
      migration_id TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS generated_image_byte_deletions (
      image_id TEXT NOT NULL CHECK (trim(image_id) <> ''),
      deletion_operation_id TEXT NOT NULL CHECK (trim(deletion_operation_id) <> ''),
      image_path TEXT NOT NULL CHECK (trim(image_path) <> ''),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      owner_kind TEXT NOT NULL DEFAULT 'local' CHECK (owner_kind IN ('local', 'provenance')),
      release_scope TEXT,
      quarantine_path TEXT,
      PRIMARY KEY (image_id, deletion_operation_id)
    );
    CREATE TABLE IF NOT EXISTS generated_image_byte_release_receipts (
      image_id TEXT NOT NULL CHECK (trim(image_id) <> ''),
      deletion_operation_id TEXT NOT NULL CHECK (trim(deletion_operation_id) <> ''),
      image_path TEXT NOT NULL CHECK (trim(image_path) <> ''),
      PRIMARY KEY (image_id, deletion_operation_id)
    );
    CREATE TABLE IF NOT EXISTS generated_image_release_scopes (
      image_id TEXT PRIMARY KEY CHECK (trim(image_id) <> ''),
      release_scope TEXT NOT NULL CHECK (trim(release_scope) <> '')
    );
    CREATE TABLE IF NOT EXISTS generated_image_release_waiters (
      release_scope TEXT NOT NULL CHECK (trim(release_scope) <> ''),
      image_id TEXT NOT NULL CHECK (trim(image_id) <> ''),
      deletion_operation_id TEXT NOT NULL CHECK (trim(deletion_operation_id) <> ''),
      PRIMARY KEY (release_scope, image_id, deletion_operation_id)
    );
    CREATE INDEX IF NOT EXISTS generated_image_release_waiters_image
    ON generated_image_release_waiters(image_id);
  `)
  const columns = db.prepare('PRAGMA table_info(generated_image_byte_deletions)').all() as Array<{
    name: string
  }>
  const waiterColumns = db
    .prepare('PRAGMA table_info(generated_image_release_waiters)')
    .all() as Array<{ name: string }>
  const receiptColumns = db
    .prepare('PRAGMA table_info(generated_image_byte_release_receipts)')
    .all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'owner_kind')) {
    db.exec(
      `ALTER TABLE generated_image_byte_deletions
       ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'local'`
    )
  }
  if (!columns.some((column) => column.name === 'release_scope')) {
    db.exec(`ALTER TABLE generated_image_byte_deletions ADD COLUMN release_scope TEXT`)
  }
  if (!columns.some((column) => column.name === 'quarantine_path')) {
    db.exec(`ALTER TABLE generated_image_byte_deletions ADD COLUMN quarantine_path TEXT`)
  }
  if (
    !columns.some((column) => column.name === 'deletion_operation_id') ||
    !waiterColumns.some((column) => column.name === 'deletion_operation_id') ||
    !receiptColumns.some((column) => column.name === 'deletion_operation_id')
  ) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE generated_image_byte_deletions_v2 (
          image_id TEXT NOT NULL, deletion_operation_id TEXT NOT NULL, image_path TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, owner_kind TEXT NOT NULL DEFAULT 'local',
          release_scope TEXT, quarantine_path TEXT, PRIMARY KEY (image_id, deletion_operation_id));
        CREATE TABLE generated_image_release_waiters_v2 (
          release_scope TEXT NOT NULL, image_id TEXT NOT NULL, deletion_operation_id TEXT NOT NULL,
          PRIMARY KEY (release_scope, image_id, deletion_operation_id));
        CREATE TABLE generated_image_byte_release_receipts_v2 (
          image_id TEXT NOT NULL, deletion_operation_id TEXT NOT NULL, image_path TEXT NOT NULL,
          PRIMARY KEY (image_id, deletion_operation_id));
      `)
      const operation = (row: Record<string, unknown>): string =>
        typeof row.deletion_operation_id === 'string' && row.deletion_operation_id.trim()
          ? row.deletion_operation_id
          : `legacy:${String(row.image_id)}`
      const intents = db.prepare('SELECT * FROM generated_image_byte_deletions').all() as Record<
        string,
        unknown
      >[]
      const putIntent = db.prepare(`INSERT OR IGNORE INTO generated_image_byte_deletions_v2
        (image_id, deletion_operation_id, image_path, attempt_count, last_error, owner_kind,
         release_scope, quarantine_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const row of intents)
        putIntent.run(
          row.image_id,
          operation(row),
          row.image_path,
          row.attempt_count,
          row.last_error,
          row.owner_kind,
          row.release_scope,
          row.quarantine_path
        )
      const putWaiter = db.prepare(`INSERT OR IGNORE INTO generated_image_release_waiters_v2
        (release_scope, image_id, deletion_operation_id) VALUES (?, ?, ?)`)
      for (const row of db.prepare('SELECT * FROM generated_image_release_waiters').all() as Record<
        string,
        unknown
      >[]) {
        const matches = intents.filter((intent) => intent.image_id === row.image_id)
        for (const match of matches.length ? matches : [row])
          putWaiter.run(row.release_scope, row.image_id, operation(match))
      }
      const putReceipt = db.prepare(`INSERT OR IGNORE INTO generated_image_byte_release_receipts_v2
        (image_id, deletion_operation_id, image_path) VALUES (?, ?, ?)`)
      for (const row of db
        .prepare('SELECT * FROM generated_image_byte_release_receipts')
        .all() as Record<string, unknown>[])
        putReceipt.run(row.image_id, operation(row), row.image_path)
      if (
        (
          db.prepare('SELECT COUNT(*) count FROM generated_image_byte_deletions_v2').get() as {
            count: number
          }
        ).count < intents.length
      )
        throw new Error('Generated-image intent operation migration lost rows.')
      db.exec(`
        ALTER TABLE generated_image_byte_deletions RENAME TO generated_image_byte_deletions_legacy;
        ALTER TABLE generated_image_release_waiters RENAME TO generated_image_release_waiters_legacy;
        ALTER TABLE generated_image_byte_release_receipts RENAME TO generated_image_byte_release_receipts_legacy;
        ALTER TABLE generated_image_byte_deletions_v2 RENAME TO generated_image_byte_deletions;
        ALTER TABLE generated_image_release_waiters_v2 RENAME TO generated_image_release_waiters;
        ALTER TABLE generated_image_byte_release_receipts_v2 RENAME TO generated_image_byte_release_receipts;
      `)
    })()
  }
  db.transaction(() => {
    db.exec(`
      INSERT OR IGNORE INTO generated_image_release_waiters(release_scope, image_id, deletion_operation_id)
      SELECT scope.release_scope, scope.image_id, intent.deletion_operation_id
      FROM generated_image_release_scopes scope
      JOIN generated_image_byte_deletions intent ON intent.image_id = scope.image_id;
      INSERT OR IGNORE INTO generated_image_release_waiters(release_scope, image_id, deletion_operation_id)
      SELECT release_scope, image_id, deletion_operation_id FROM generated_image_byte_deletions
      WHERE release_scope IS NOT NULL;
      DELETE FROM generated_image_release_scopes;
      UPDATE generated_image_byte_deletions SET release_scope = NULL
      WHERE release_scope IS NOT NULL;
    `)
  })()
}

function state(db: Database.Database): StateRow {
  return db
    .prepare('SELECT revision, images_json FROM generated_image_gallery_state WHERE singleton = 1')
    .get() as StateRow
}

/** Durable Desktop storage mechanics for the Shared generated-image gallery owner. */
export class DesktopGeneratedImageGalleryRepository implements GeneratedImageGalleryRepositoryPort {
  private readonly settlements = new Map<string, Promise<void | 'fenced'>>()
  private readonly removalFences = new Map<string, () => boolean>()
  readonly creationIntents: GeneratedImageCreationIntentRepository

  constructor(private readonly db: Database.Database) {
    createSchema(db)
    this.creationIntents = new GeneratedImageCreationIntentRepository(db)
  }

  async read(): Promise<{ revision: string; images: readonly GeneratedImageRecord[] }> {
    const current = state(this.db)
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
      const current = state(this.db)
      if (current.revision !== Number(input.expectedRevision)) return false
      const conversationExists = this.db.prepare(
        `SELECT 1 FROM workspace_content_conversations c
         WHERE c.id = ? AND NOT EXISTS (
           SELECT 1 FROM workspace_content_conversation_deletion_intents d
           WHERE d.conversation_id = c.id AND d.state != 'completed'
         )`
      )
      const fenced = input.images.find(
        (image) => image.conversationId && !conversationExists.get(image.conversationId)
      )
      if (fenced?.conversationId) {
        throw new Error(`Conversation ${fenced.conversationId} is missing or being deleted.`)
      }
      const retained = new Set(input.images.map((image) => image.id))
      // EVERY removed record gets an intent, provenance included. The intent records WHICH owner
      // may act, so the metadata row and the durable knowledge of its bytes leave together. A
      // remote-provenance path is stored verbatim - it is the Shared File owner's to confine, and
      // it is never resolved against this app's generated-image library.
      const removed = (JSON.parse(current.images_json) as GeneratedImageRecord[])
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
        (JSON.parse(state(this.db).images_json) as GeneratedImageRecord[]).map((image) => image.id)
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
      for (const imageId of [...new Set(imageIds)].sort()) {
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
      const current = (JSON.parse(state(this.db).images_json) as GeneratedImageRecord[]).find(
        (image) => image.id === row.image_id
      )
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
      const replacement = (JSON.parse(state(this.db).images_json) as GeneratedImageRecord[]).find(
        (image) => image.id === row.image_id
      )
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

function ownedImagePath(candidate: string): string {
  const root = fs.realpathSync.native(path.join(dataDir(), 'generated-images'))
  const resolved = path.resolve(candidate)
  if (
    !path.isAbsolute(candidate) ||
    path.dirname(resolved) !== root ||
    !isGeneratedImageFile(resolved)
  ) {
    throw new Error('Generated image deletion path is outside the app image library.')
  }
  if (!fs.existsSync(resolved)) return resolved
  const owned = resolveExistingOwnedPath(root, resolved)
  if (!owned) throw new Error('Generated image deletion path is not an owned file.')
  return owned
}

async function contentIdentity(imagePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.promises.readFile(imagePath))
    .digest('hex')
}

interface LegacyGalleryRecord {
  readonly record: GeneratedImageRecord
  readonly messageId?: string
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

async function legacyRecord(imagePath: string): Promise<LegacyGalleryRecord> {
  const sidecar = readGeneratedImageSidecar(imagePath)
  const generation = readGeneratedImageMetadata(sidecar.metadataJson)
  const image = await sharp(imagePath).metadata()
  const stat = await fs.promises.stat(imagePath)
  const id = sidecar.syncId ?? (await contentIdentity(imagePath))
  const width = sidecar.width ?? image.width
  const height = sidecar.height ?? image.height
  assertLegacyMessageRelation(imagePath, sidecar)
  if (
    !generation?.prompt ||
    !generation.modelId ||
    !generation.steps ||
    generation.seed === undefined
  )
    throw new Error(`Generated image ${path.basename(imagePath)} has incomplete generation facts.`)
  if (!width || !height)
    throw new Error(`Generated image ${path.basename(imagePath)} has no readable dimensions.`)
  return {
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
      modelId: generation.modelId,
      createdAt: sidecar.createdAt ?? stat.mtime.toISOString(),
      local: { path: imagePath, fileName: path.basename(imagePath) }
    }),
    ...(sidecar.messageId ? { messageId: sidecar.messageId } : {})
  }
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
  return Promise.all(
    names
      .filter((name) => isGeneratedImageFile(name) && !name.startsWith('preview-'))
      .sort()
      .flatMap((name) => {
        const imagePath = resolveExistingOwnedEntry(directory, name)
        return imagePath ? [legacyRecord(imagePath)] : []
      })
  )
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

async function migrateMessageRelation(item: LegacyGalleryRecord): Promise<void> {
  if (!item.messageId) return
  const snapshot = desktopWorkspaceContent.snapshot()
  if (snapshot.status !== 'ready')
    throw new Error('Workspace Content is not ready for gallery migration.')
  const message = snapshot.messages.find((candidate) => candidate.id === item.messageId)
  if (!message) throw new Error(`Generated image message ${item.messageId} was not found.`)
  if (message.conversationId !== item.record.conversationId) {
    throw new Error(`Generated image ${item.record.id} has a conflicting message conversation.`)
  }
  const content = migratedContent(message, item.record)
  if (content === message.portable.content) return
  const outcome = await desktopWorkspaceContent.execute({
    type: 'update_message',
    origin: 'migration',
    messageId: message.id,
    portable: { ...message.portable, content }
  })
  if (!outcome.ok) throw new Error(outcome.failure.message)
}

/** Import the old sidecar inventory exactly once through Shared validation and conflict policy. */
export async function migrateGeneratedImageSidecars(input: {
  readonly repository: DesktopGeneratedImageGalleryRepository
  readonly gallery: GeneratedImageGalleryFacade
}): Promise<void> {
  if (input.repository.migrationComplete()) return
  const legacy = await readLegacyRecords()
  for (const item of legacy) await migrateMessageRelation(item)
  const outcome = await input.gallery.importLegacy(legacy.map((item) => item.record))
  if (!outcome.ok) throw new Error(outcome.failure.message)
  input.repository.markMigrationComplete()
}

/** Move old local bytes off the live path before any asynchronous destructive I/O. */
async function quarantineAndReleaseOwnedBytes(
  db: Database.Database,
  row: ByteDeletionRow,
  commitFence?: ByteDeletionFence
): Promise<void> {
  const owned = ownedImagePath(row.image_path)
  const root = path.dirname(owned)
  const quarantineRoot = path.join(root, '.deletion-quarantine')
  const operationKey = createHash('sha256')
    .update(`${row.image_id}\u0000${row.deletion_operation_id}`)
    .digest('hex')
  const quarantinePath = path.join(quarantineRoot, `${operationKey}-${path.basename(owned)}`)
  if (row.quarantine_path && path.resolve(row.quarantine_path) !== quarantinePath) {
    throw new Error('Generated image deletion quarantine evidence is invalid.')
  }
  fs.mkdirSync(quarantineRoot, { recursive: true })
  db.prepare(
    `UPDATE generated_image_byte_deletions SET quarantine_path = ?
     WHERE image_id = ? AND deletion_operation_id = ?`
  ).run(quarantinePath, row.image_id, row.deletion_operation_id)

  if (!fs.existsSync(quarantinePath) && fs.existsSync(owned)) {
    if (commitFence && !commitFence()) return
    fs.renameSync(owned, quarantinePath)
    const liveSidecar = generatedImageSidecarPath(owned)
    if (fs.existsSync(liveSidecar)) {
      fs.renameSync(liveSidecar, generatedImageSidecarPath(quarantinePath))
    }
  }
  await fs.promises.rm(quarantinePath, { force: true })
  await fs.promises.rm(generatedImageSidecarPath(quarantinePath), { force: true })
}

/**
 * Ask the Shared File owner to release bytes it wrote. No byte is unlinked here.
 *
 * A missing owner or typed failure stays durable. Only the owner's proved settled outcomes may end
 * the retry.
 */
async function releaseProvenanceBytes(intent: GeneratedImageReleaseIntent): Promise<void> {
  const release = desktopReceivedMediaRelease()
  if (!release) {
    throw new Error('No Shared File owner is running to release this received image.')
  }
  const outcome = await release(intent)
  if (outcome.status === 'failed') throw new Error(outcome.message)
}
