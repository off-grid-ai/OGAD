// The free video library: clips already on this computer can be listed, played, exported and
// deleted without Pro. Generation lives in the private Pro package.
import fs from 'node:fs'
import path from 'node:path'
import { callHook } from '../bootstrap/hookRegistry'
import { getDB, updateRagMessage } from '../database'
import { readGeneratedVideoReference } from '../../shared/generated-video-reference'
import { resolveExistingOwnedEntry, resolveExistingOwnedPath } from '../imagegen/owned-path'
import { dataDir } from '../runtime-env'
import { emitSharedFileMutation } from '../sync-shared-file'
import { generatedVideoSidecarPath, readGeneratedVideoSidecar } from './gallery-sidecar'
import { describeOwnGeneratedVideo } from './generated-video-share'

export const generatedVideosDir = (): string => path.join(dataDir(), 'generated-videos')

/**
 * ({ syncId?: string; storyId?: string }) => void - a film was deleted from the library. Pro's
 * Video Studio registers it so the story forgets its film; free builds have no stories.
 */
export const VIDEO_FILM_DELETED_HOOK = 'video:filmDeleted'

/** A film's captions sit beside it with the same name. */
export const generatedVideoCaptionsPath = (videoPath: string): string =>
  videoPath.replace(/\.mp4$/i, '.vtt')

export function listGeneratedVideos(scope?: {
  conversationId?: string
  projectId?: string | null
}): Array<{
  path: string
  name: string
  mtime: number
  syncId?: string
  conversationId?: string
  projectId?: string | null
  durationSeconds?: number
}> {
  const root = generatedVideosDir()
  try {
    return fs
      .readdirSync(root)
      .filter((name) => /\.mp4$/i.test(name))
      .flatMap((name) => {
        const owned = resolveExistingOwnedEntry(root, name)
        if (!owned) return []
        const facts = readGeneratedVideoSidecar(owned)
        if (scope?.conversationId && facts.conversationId !== scope.conversationId) return []
        if (
          !scope?.conversationId &&
          scope?.projectId !== undefined &&
          (facts.projectId ?? null) !== scope.projectId
        )
          return []
        return [{ path: owned, name, mtime: fs.statSync(owned).mtimeMs, ...facts }]
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

export function deleteGeneratedVideo(candidate: string): boolean {
  const owned = resolveExistingOwnedPath(generatedVideosDir(), candidate)
  if (!owned || !owned.endsWith('.mp4')) return false
  try {
    let shared: ReturnType<typeof describeOwnGeneratedVideo> = null
    try {
      shared = describeOwnGeneratedVideo(owned)
    } catch {
      /* An older local clip can lack sync metadata. */
    }
    const messages = getDB()
      .prepare(
        "SELECT uuid, conversation_id, content, context FROM rag_messages WHERE context LIKE '%videoRef%'"
      )
      .all() as Array<{ uuid: string; conversation_id: string; content: string; context: string }>
    for (const message of messages) {
      let context: Record<string, unknown>
      try {
        context = JSON.parse(message.context) as Record<string, unknown>
      } catch {
        continue
      }
      const reference = readGeneratedVideoReference(context)
      if (
        !reference ||
        (reference.path !== owned && !(shared?.syncId && reference.id === shared.syncId))
      )
        continue
      delete context.videoRef
      updateRagMessage(message.conversation_id, message.uuid, message.content, context)
    }
    const facts = readGeneratedVideoSidecar(owned)
    fs.rmSync(owned)
    fs.rmSync(generatedVideoSidecarPath(owned), { force: true })
    fs.rmSync(generatedVideoCaptionsPath(owned), { force: true })
    if (shared) emitSharedFileMutation({ kind: 'delete', file: shared })
    if (facts.storyId) {
      try {
        callHook(VIDEO_FILM_DELETED_HOOK, {
          syncId: facts.syncId ?? shared?.syncId,
          storyId: facts.storyId
        })
      } catch (error) {
        console.error('[video-library] Cannot clear the deleted film from its story.', error)
      }
    }
    return true
  } catch {
    return false
  }
}

export async function exportGeneratedVideo(candidate: string, destination: string): Promise<void> {
  const owned = resolveExistingOwnedPath(generatedVideosDir(), candidate)
  if (!owned || !owned.endsWith('.mp4')) throw new Error('Video is outside the gallery.')
  await fs.promises.copyFile(owned, destination)
}
