import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DeletionCleanupContinuation } from '@offgrid/application'
import { isGeneratedImageFile } from '@offgrid/models'
import type Database from 'better-sqlite3-multiple-ciphers'
import { dataDir } from '../runtime-env'
import {
  desktopReceivedMediaRelease,
  type GeneratedImageReleaseIntent
} from './generated-image-release'
import { generatedImageSidecarPath } from './gallery-sidecar'
import { resolveExistingOwnedPath } from './owned-path'

export interface ByteDeletionRow {
  image_id: string
  deletion_operation_id: string
  image_path: string
  owner_kind: string
  quarantine_path: string | null
}

export type ByteDeletionFence = DeletionCleanupContinuation | (() => boolean)

export function ownedImagePath(candidate: string): string {
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

/** Move old local bytes off the live path before any asynchronous destructive I/O. */
export async function quarantineAndReleaseOwnedBytes(
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
  const recorded = db
    .prepare(
      `UPDATE generated_image_byte_deletions SET quarantine_path = ?
       WHERE image_id = ? AND deletion_operation_id = ?`
    )
    .run(quarantinePath, row.image_id, row.deletion_operation_id)
  if (recorded.changes !== 1) {
    throw new Error('Generated image deletion intent disappeared before quarantine.')
  }

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

/** Ask the Shared File owner to release bytes it wrote. No byte is unlinked here. */
export async function releaseProvenanceBytes(intent: GeneratedImageReleaseIntent): Promise<void> {
  const release = desktopReceivedMediaRelease()
  if (!release) {
    throw new Error('No Shared File owner is running to release this received image.')
  }
  const outcome = await release(intent)
  if (outcome.status === 'failed') throw new Error(outcome.message)
}
