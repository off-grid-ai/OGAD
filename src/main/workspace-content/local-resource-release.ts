import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  GeneratedImageRecord,
  WorkspaceContentLocalResourceRelease
} from '@offgrid/application'
import type Database from 'better-sqlite3-multiple-ciphers'
import { dataDir } from '../runtime-env'

type ReleaseRow = {
  id: string
  content_id: string
  uri: string | null
  data: string | null
}

type GalleryStateRow = { images_json: string }
type GalleryReleaseRow = { image_path: string }
type SharedFileStateRow = { local_path: string }
type ConfinedPath = { readonly path: string; readonly exists: boolean }

function localPath(value: string): string | null {
  try {
    if (value.startsWith('data:')) return null
    if (value.startsWith('file://')) return fileURLToPath(value)
    return path.isAbsolute(value) ? path.normalize(value) : null
  } catch {
    return null
  }
}

function confinedPath(candidate: string): ConfinedPath | null {
  const root = fs.realpathSync.native(dataDir())
  const resolved = path.resolve(candidate)
  const lexical = path.relative(root, resolved)
  if (!lexical || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) return null
  try {
    const stat = fs.lstatSync(resolved)
    if (stat.isSymbolicLink()) {
      throw new Error('A local message resource cannot be a symbolic link.')
    }
    if (!stat.isFile()) {
      throw new Error('A local message resource must be a regular file.')
    }
    const existing = fs.realpathSync.native(resolved)
    const relative = path.relative(root, existing)
    return relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? { path: existing, exists: true }
      : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const parent = fs.realpathSync.native(path.dirname(resolved))
      const missing = path.join(parent, path.basename(resolved))
      const relative = path.relative(root, missing)
      return relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        ? { path: missing, exists: false }
        : null
    }
    throw error
  }
}

function isGeneratedImagePath(candidate: string): boolean {
  const root = fs.realpathSync.native(path.join(dataDir(), 'generated-images'))
  const relative = path.relative(root, candidate)
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function recordPath(record: GeneratedImageRecord): string | null {
  return localPath(record.local.path)
}

/** Desktop byte settlement for Shared-planned message-local release identities. */
export class DesktopWorkspaceContentLocalResourceReleaseOwner {
  private active: Promise<void> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private running = true
  private suspensionCount = 0

  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_content_local_resource_releases (
      id TEXT PRIMARY KEY CHECK (trim(id) <> ''),
      transaction_id TEXT NOT NULL CHECK (trim(transaction_id) <> ''),
      transaction_order INTEGER NOT NULL CHECK (transaction_order >= 0),
      message_id TEXT NOT NULL CHECK (trim(message_id) <> ''),
      content_id TEXT NOT NULL CHECK (trim(content_id) <> ''),
      uri TEXT,
      data TEXT,
      created_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      UNIQUE(transaction_id, transaction_order)
    )`)
  }

  insert(
    transactionId: string,
    releases: readonly WorkspaceContentLocalResourceRelease[],
    createdAt: string
  ): void {
    if (!this.running) {
      throw new Error('Local resource release admission is closed.')
    }
    const statement = this.db.prepare(
      `INSERT INTO workspace_content_local_resource_releases(
         id, transaction_id, transaction_order, message_id, content_id, uri, data, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    releases.forEach((release, order) =>
      statement.run(
        `${transactionId}:release:${String(order)}`,
        transactionId,
        order,
        release.messageId,
        release.contentId,
        release.uri ?? null,
        release.data ?? null,
        createdAt
      )
    )
  }

  drain(): Promise<void> {
    if (!this.running || this.suspensionCount > 0) return Promise.resolve()
    return this.startDrain()
  }

  start(): Promise<void> {
    this.running = true
    return this.drain()
  }

  async stop(): Promise<void> {
    this.running = false
    this.clearRetry()
    await this.active?.catch(() => undefined)
  }

  async suspend(): Promise<void> {
    this.suspensionCount += 1
    this.clearRetry()
    await this.active?.catch(() => undefined)
  }

  resume(): void {
    if (this.suspensionCount === 0) return
    this.suspensionCount -= 1
    if (this.suspensionCount === 0) this.scheduleRetry()
  }

  async settleForPrivacy(): Promise<void> {
    if (this.suspensionCount === 0) {
      throw new Error('Local resource releases require suspended mutation admission.')
    }
    await this.startDrain()
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM workspace_content_local_resource_releases')
      .get() as { count: number }
    if (row.count !== 0) throw new Error('Local resource release work is not settled.')
  }

  private startDrain(): Promise<void> {
    if (this.active) return this.active
    const current = Promise.resolve()
      .then(() => this.performDrain())
      .catch((cause) => {
        this.scheduleRetry()
        throw cause
      })
      .finally(() => {
        if (this.active === current) this.active = null
      })
    this.active = current
    return current
  }

  private performDrain(): void {
    const rows = this.db
      .prepare(
        `SELECT id, content_id, uri, data FROM workspace_content_local_resource_releases
         ORDER BY rowid ASC`
      )
      .all() as ReleaseRow[]
    let firstFailure: unknown = null
    for (const row of rows) {
      try {
        this.settle(row)
      } catch (cause) {
        // Rows are independent durable work. Retain and retry the failed row, but never let one
        // permanently unowned path starve later releases in this pass.
        firstFailure ??= cause
      }
    }
    if (firstFailure) throw firstFailure
  }

  private settle(row: ReleaseRow): void {
    try {
      // `data` is inline content, never a filesystem capability. Only an explicit URI may name a
      // platform-owned file. Once the canonical message-local row is gone, dropping this release
      // row is sufficient to settle inline data.
      if (row.uri) {
        const candidate = localPath(row.uri)
        if (!candidate) throw new Error('A local message resource URI is not a file path.')
        const owned = confinedPath(candidate)
        if (owned === null)
          throw new Error('A local message resource is outside app-owned storage.')
        if (isGeneratedImagePath(owned.path)) {
          this.settleGalleryOwned(row, owned.path)
          return
        }
        this.settleSharedFileOwned(row, owned.path)
        return
      }
      this.deleteEvidence(row)
    } catch (cause) {
      this.db
        .prepare(
          `UPDATE workspace_content_local_resource_releases
           SET attempt_count = attempt_count + 1, last_error = ? WHERE id = ?`
        )
        .run(cause instanceof Error ? cause.message : String(cause), row.id)
      throw cause
    }
  }

  /**
   * A generated-image path is never a generic message byte. The gallery row keeps it alive; after
   * gallery removal, its own byte journal owns deletion. Any other state is ambiguous and remains
   * durable for repair without touching the file.
   */
  private settleGalleryOwned(row: ReleaseRow, candidate: string): void {
    this.db.transaction(() => {
      const galleryState = this.db
        .prepare('SELECT images_json FROM generated_image_gallery_state WHERE singleton = 1')
        .get() as GalleryStateRow | undefined
      if (!galleryState) throw new Error('Generated-image gallery state is unavailable.')
      const decoded: unknown = JSON.parse(galleryState.images_json)
      if (!Array.isArray(decoded)) throw new Error('Generated-image gallery state is invalid.')
      const matches = (decoded as GeneratedImageRecord[]).filter(
        (image) => image.id === row.content_id && image.contentId === row.content_id
      )
      if (matches.length > 1) throw new Error('Generated-image gallery ownership is ambiguous.')
      if (matches.length === 1) {
        const ownerPath = recordPath(matches[0]!)
        if (!ownerPath || path.resolve(ownerPath) !== path.resolve(candidate)) {
          throw new Error('Generated-image gallery ownership conflicts with the release path.')
        }
        this.deleteEvidence(row)
        return
      }
      const pending = this.db
        .prepare('SELECT image_path FROM generated_image_byte_deletions WHERE image_id = ?')
        .get(row.content_id) as GalleryReleaseRow | undefined
      if (pending) {
        if (path.resolve(pending.image_path) !== path.resolve(candidate)) {
          throw new Error('Generated-image gallery release path conflicts with the message path.')
        }
        this.deleteEvidence(row)
        return
      }
      const settled = this.db
        .prepare('SELECT image_path FROM generated_image_byte_release_receipts WHERE image_id = ?')
        .get(row.content_id) as GalleryReleaseRow | undefined
      if (!settled || path.resolve(settled.image_path) !== path.resolve(candidate)) {
        throw new Error('Generated-image bytes have no canonical gallery release owner.')
      }
      // A gallery tombstone proves the canonical owner settled the image bytes. It is reusable:
      // several admitted messages may reference one image identity, and each message has its own
      // release evidence. Consuming the tombstone for the first reference would strand the rest.
      this.deleteEvidence(row)
    })()
  }

  /** A Shared File reference never grants this generic owner authority to unlink its bytes. */
  private settleSharedFileOwned(row: ReleaseRow, candidate: string): void {
    this.db.transaction(() => {
      const owner = this.db
        .prepare('SELECT local_path FROM sync_shared_files WHERE sync_id = ?')
        .get(row.content_id) as SharedFileStateRow | undefined
      if (!owner) throw new Error('Local message bytes have no canonical platform release owner.')
      const owned = confinedPath(owner.local_path)
      if (!owned || path.resolve(owned.path) !== path.resolve(candidate)) {
        throw new Error('Shared File ownership conflicts with the message resource path.')
      }
      this.deleteEvidence(row)
    })()
  }

  private deleteEvidence(row: ReleaseRow): void {
    const deleted = this.db
      .prepare(
        `DELETE FROM workspace_content_local_resource_releases
         WHERE id = ? AND content_id = ? AND uri IS ? AND data IS ?`
      )
      .run(row.id, row.content_id, row.uri, row.data)
    if (deleted.changes !== 1) {
      throw new Error('Local resource release evidence changed during settlement.')
    }
  }

  private scheduleRetry(): void {
    if (this.retry || !this.running || this.suspensionCount > 0) return
    this.retry = setTimeout(() => {
      this.retry = null
      void this.drain().catch((error) =>
        console.error('[workspace-content] local resource release retry failed', error)
      )
    }, 2_000)
  }

  private clearRetry(): void {
    if (!this.retry) return
    clearTimeout(this.retry)
    this.retry = null
  }
}
