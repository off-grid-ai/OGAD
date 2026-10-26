import fs from 'node:fs'

export interface GeneratedVideoSidecar {
  syncId?: string
  conversationId?: string
  projectId?: string | null
  messageId?: string
  createdAt?: string
  width?: number
  height?: number
  durationSeconds?: number
  metadataJson?: string
  /** A film joined from a Studio story. Clips have none. */
  storyId?: string
}

export const generatedVideoSidecarPath = (videoPath: string): string => `${videoPath}.json`

export function readGeneratedVideoSidecar(videoPath: string): GeneratedVideoSidecar {
  try {
    const value = JSON.parse(
      fs.readFileSync(generatedVideoSidecarPath(videoPath), 'utf8')
    ) as Record<string, unknown> | null
    if (!value || typeof value !== 'object') return {}
    return {
      ...(typeof value.syncId === 'string' ? { syncId: value.syncId } : {}),
      ...(typeof value.conversationId === 'string' ? { conversationId: value.conversationId } : {}),
      ...(typeof value.projectId === 'string' || value.projectId === null
        ? { projectId: value.projectId as string | null }
        : {}),
      ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
      ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
      ...(typeof value.width === 'number' ? { width: value.width } : {}),
      ...(typeof value.height === 'number' ? { height: value.height } : {}),
      ...(typeof value.durationSeconds === 'number'
        ? { durationSeconds: value.durationSeconds }
        : {}),
      ...(typeof value.metadataJson === 'string' ? { metadataJson: value.metadataJson } : {}),
      ...(typeof value.storyId === 'string'
        ? { storyId: value.storyId }
        : storyIdOfMetadata(value.metadataJson))
    }
  } catch {
    return {}
  }
}

/**
 * A Studio film carries its story and its captions inside the shared file's metadata, so a film
 * received from another device knows its story and gets its captions file beside it.
 */
function filmMetadata(json: unknown): Record<string, unknown> | null {
  if (typeof json !== 'string') return null
  try {
    const value = JSON.parse(json) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function storyIdOfMetadata(json: unknown): { storyId?: string } {
  const storyId = filmMetadata(json)?.storyId
  return typeof storyId === 'string' && storyId ? { storyId } : {}
}

/** The captions a received film carried, written beside it when it has none yet. */
function writeCarriedCaptions(videoPath: string, metadataJson: string | undefined): void {
  const captions = filmMetadata(metadataJson)?.captionsVtt
  if (typeof captions !== 'string' || !captions.startsWith('WEBVTT')) return
  const destination = videoPath.replace(/\.mp4$/i, '.vtt')
  if (destination === videoPath || fs.existsSync(destination)) return
  try {
    fs.writeFileSync(destination, captions)
  } catch (error) {
    console.error('[video-sidecar] Cannot write the film captions.', error)
  }
}

export function writeGeneratedVideoSidecar(videoPath: string, facts: GeneratedVideoSidecar): void {
  const destination = generatedVideoSidecarPath(videoPath)
  const temporary = `${destination}.tmp`
  const next = { ...readGeneratedVideoSidecar(videoPath), ...facts }
  try {
    fs.writeFileSync(temporary, JSON.stringify(next))
    fs.renameSync(temporary, destination)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  writeCarriedCaptions(videoPath, next.metadataJson)
}
