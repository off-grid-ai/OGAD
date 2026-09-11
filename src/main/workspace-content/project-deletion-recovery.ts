import type { DeletionCleanupContinuation, ProjectDeletionCleanupPort } from '@offgrid/application'
import type Database from 'better-sqlite3-multiple-ciphers'
import { desktopWorkspaceContent } from '../composition/application-access'
import { removeProjectArtifactsForRecovery } from '../artifacts'
import { listGeneratedImages } from '../imagegen'
import {
  desktopGeneratedImageGallery,
  type DesktopGeneratedImageGalleryRepository
} from '../imagegen/gallery-repository'
import {
  DesktopAttachmentIdentityError,
  retainedLocalContentIdentities
} from './local-content-identities'
export { DesktopProjectDeletionIntentRepository } from './project-deletion-intent-repository'

/** Strict artifact-library boundary for the Shared recovery phase. */
export const desktopProjectArtifactCleanup: ProjectDeletionCleanupPort = {
  async removeProject(projectId, commitFence) {
    return removeProjectArtifactsForRecovery(projectId, commitFence)
  }
}

/**
 * Generated-image cleanup for the Shared `media` recovery phase.
 *
 * The canonical Shared gallery owns the record set and the Desktop gallery repository owns the
 * byte journal, so this cleanup only decides WHICH stable image identities this project releases
 * and then drives the two canonical steps in order:
 *
 * 1. capture - resolve the project's removable stable IDs from the canonical projection while the
 *    Workspace Content project still exists (the `media` phase runs before `workspace_content`),
 *    and persist them on the existing durable project intent. After a restart the capture is read
 *    back instead of recomputed, so a project whose conversations are already gone still releases
 *    exactly the images the first attempt decided on.
 * 2. scope - durably tag those IDs with the stable project deletion scope before removal.
 * 3. release - await `generatedImages.remove` per captured ID, then await only that scope in the
 *    canonical byte journal. Bytes and the legacy sidecar are deleted by that owner alone; this
 *    caller performs no direct image or sidecar file I/O.
 *
 * The capture is cleared only after settlement succeeds, so any failure leaves a durable, replayable
 * phase and a typed error for the Shared workflow to record.
 *
 * The single composed `DesktopGeneratedImageGalleryRepository` is injected directly, so scope
 * capture and settlement address the same transaction and journal owner that canonical removal uses.
 */
export class DesktopProjectMediaCleanup implements ProjectDeletionCleanupPort {
  constructor(
    private readonly db: Database.Database,
    private readonly releases: Pick<
      DesktopGeneratedImageGalleryRepository,
      'captureByteDeletionScope' | 'settleByteDeletionsForScope' | 'withRemovalFence'
    >
  ) {}

  async removeProject(
    projectId: string,
    continuation?: DeletionCleanupContinuation
  ): Promise<void | 'fenced'> {
    const winnerIsCurrent = continuation ?? (() => true)
    if (!winnerIsCurrent()) return 'fenced'
    const ids = this.captured(projectId) ?? this.capture(projectId)
    const releaseScope = `project:${projectId}`
    this.releases.captureByteDeletionScope(releaseScope, ids)
    for (const id of ids) {
      if (!winnerIsCurrent()) return 'fenced'
      const outcome = await this.releases.withRemovalFence({
        imageId: id,
        isCurrentWinner: winnerIsCurrent,
        work: () => desktopGeneratedImageGallery().remove(id)
      })
      if (!outcome.ok && !winnerIsCurrent()) return 'fenced'
      // An already-removed record is the settled result of an earlier attempt, not a failure.
      if (!outcome.ok && outcome.failure.kind !== 'not_found') {
        throw new Error(outcome.failure.message)
      }
    }
    if (!winnerIsCurrent()) return 'fenced'
    const settlement = await this.releases.settleByteDeletionsForScope(
      releaseScope,
      winnerIsCurrent
    )
    if (settlement === 'fenced') return settlement
    this.clear(projectId)
  }

  /** Stable IDs a previous attempt already committed to, or undefined before the first capture. */
  private captured(projectId: string): readonly string[] | undefined {
    const row = this.db
      .prepare(
        `SELECT pending_generated_image_ids_json AS ids
         FROM workspace_content_project_deletion_intents WHERE project_id = ?`
      )
      .get(projectId) as { ids: string | null } | undefined
    if (!row || row.ids === null) return undefined
    const ids: unknown = JSON.parse(row.ids)
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new Error(
        `Project deletion intent ${projectId} has invalid generated-image identities.`
      )
    }
    return ids
  }

  private capture(projectId: string): readonly string[] {
    const snapshot = desktopWorkspaceContent.snapshot()
    if (snapshot.status !== 'ready') {
      throw new Error('Workspace Content is not ready for project media cleanup.')
    }
    const retained = retainedLocalContentIdentities(snapshot.messages)
    if (!retained.ok) throw new DesktopAttachmentIdentityError(retained.failure)
    const ids: string[] = []
    for (const image of listGeneratedImages({ projectId })) {
      if (
        retained.value.filePaths.has(image.path) ||
        (image.syncId !== undefined && retained.value.contentIds.has(image.syncId))
      ) {
        continue
      }
      if (image.syncId === undefined) {
        throw new Error('An app-owned generated image has no canonical gallery identity.')
      }
      ids.push(image.syncId)
    }
    this.persist(projectId, ids)
    return ids
  }

  private persist(projectId: string, ids: readonly string[]): void {
    const result = this.db
      .prepare(
        `UPDATE workspace_content_project_deletion_intents
         SET pending_generated_image_ids_json = ? WHERE project_id = ?`
      )
      .run(JSON.stringify(ids), projectId)
    if (result.changes !== 1) {
      throw new Error(`Project deletion intent ${projectId} is missing for media cleanup.`)
    }
  }

  private clear(projectId: string): void {
    this.db
      .prepare(
        `UPDATE workspace_content_project_deletion_intents
         SET pending_generated_image_ids_json = NULL WHERE project_id = ?`
      )
      .run(projectId)
  }
}
