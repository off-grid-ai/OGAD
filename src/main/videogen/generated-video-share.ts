import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  describeGeneratedVideo,
  readGeneratedVideoMetadata,
  type ChatHome,
  type SharedFileDescriptor
} from '@offgrid/sync'
import { emitSharedFileMutation } from '../sync-shared-file'
import { readGeneratedVideoSidecar, writeGeneratedVideoSidecar } from './gallery-sidecar'

export function describeOwnGeneratedVideo(videoPath: string, shownIn?: ChatHome): SharedFileDescriptor | null {
  const facts = readGeneratedVideoSidecar(videoPath)
  const metadata = readGeneratedVideoMetadata(facts.metadataJson)
  if (!facts.syncId || !metadata || !facts.width || !facts.height || !facts.durationSeconds) return null
  const stat = fs.statSync(videoPath)
  const home = shownIn ?? (facts.conversationId && facts.messageId
    ? { conversationId: facts.conversationId, messageId: facts.messageId }
    : undefined)
  return describeGeneratedVideo({
    syncId: facts.syncId,
    name: path.basename(videoPath),
    fileSize: stat.size,
    createdAt: facts.createdAt ?? new Date(stat.mtimeMs).toISOString(),
    ...(facts.conversationId ? { conversationId: facts.conversationId } : {}),
    width: facts.width,
    height: facts.height,
    durationSeconds: facts.durationSeconds,
    metadata
  }, home)
}

export function describeGeneratedVideoEnsuringIdentity(videoPath: string): SharedFileDescriptor | null {
  if (!readGeneratedVideoSidecar(videoPath).syncId) {
    writeGeneratedVideoSidecar(videoPath, { syncId: randomUUID() })
  }
  return describeOwnGeneratedVideo(videoPath)
}

export function shareGeneratedVideo(videoPath: string, shownIn?: ChatHome): boolean {
  try {
    const file = describeOwnGeneratedVideo(videoPath, shownIn)
    if (!file) {
      console.error('[video-share] Clip is too large or has incomplete metadata.', videoPath)
      return false
    }
    emitSharedFileMutation({ kind: 'put', filePath: videoPath, file })
    return true
  } catch (error) {
    console.error('[video-share] Cannot share generated clip.', error)
    return false
  }
}

export function noteGeneratedVideoMessage(link: ChatHome & { videoPath: string }): boolean {
  const before = readGeneratedVideoSidecar(link.videoPath)
  if (before.conversationId === link.conversationId && before.messageId === link.messageId) return true
  writeGeneratedVideoSidecar(link.videoPath, {
    conversationId: link.conversationId,
    messageId: link.messageId
  })
  return shareGeneratedVideo(link.videoPath, link)
}
