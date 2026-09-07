import { getDB } from '../database'
import {
  desktopGeneratedImageGallery,
  removeDesktopGeneratedImage,
  settleDesktopGeneratedImageReleases
} from './gallery-repository'
import { settleDesktopGeneratedImageCreationIntentsForPrivacy } from './creation-intent-runtime'
import { clearGeneratedImagePublicationState } from './generated-image-share'
import { desktopWorkspaceContentPersistence } from '../composition/workspace-content'

function assertTableEmpty(table: string, message: string): void {
  const row = getDB().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  if (row.count !== 0) throw new Error(message)
}

/** Forget completed sidecar admission only after its source directories are empty. */
export function clearDesktopGeneratedImageMigrationState(): void {
  getDB().prepare('DELETE FROM generated_image_gallery_migrations').run()
  assertTableEmpty('generated_image_gallery_migrations', 'Image migration state is not empty.')
}

/** Clear the canonical live gallery and settle every durable local or provenance byte release. */
export async function clearDesktopGeneratedImageGallery(): Promise<void> {
  await desktopWorkspaceContentPersistence().privacy.settleLocalResourceReleases()
  settleDesktopGeneratedImageCreationIntentsForPrivacy()
  const gallery = desktopGeneratedImageGallery()
  const imageIds = gallery
    .snapshot()
    .images.map((image) => image.id)
    .sort((left, right) => left.localeCompare(right))
  for (const imageId of imageIds) {
    const outcome = await removeDesktopGeneratedImage(imageId)
    if (outcome.status === 'failed') throw new Error(outcome.message)
  }
  await settleDesktopGeneratedImageReleases()
  if (gallery.snapshot().images.length !== 0) {
    throw new Error('Canonical generated-image data is not empty.')
  }
  assertTableEmpty('generated_image_byte_deletions', 'Image byte deletion work is not settled.')
  assertTableEmpty('generated_image_release_scopes', 'Legacy image release scopes are not empty.')
  assertTableEmpty('generated_image_release_waiters', 'Image release waiters are not settled.')
  assertTableEmpty(
    'generated_image_creation_intents',
    'Image creation recovery evidence is not settled.'
  )
  clearGeneratedImagePublicationState()
}
