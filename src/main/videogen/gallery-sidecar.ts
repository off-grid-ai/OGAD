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
}

export const generatedVideoSidecarPath = (videoPath: string): string => `${videoPath}.json`

export function readGeneratedVideoSidecar(videoPath: string): GeneratedVideoSidecar {
  try {
    const value = JSON.parse(fs.readFileSync(generatedVideoSidecarPath(videoPath), 'utf8')) as Record<string, unknown>
    if (!value || typeof value !== 'object') return {}
    return {
      ...(typeof value.syncId === 'string' ? { syncId: value.syncId } : {}),
      ...(typeof value.conversationId === 'string' ? { conversationId: value.conversationId } : {}),
      ...(typeof value.projectId === 'string' || value.projectId === null ? { projectId: value.projectId as string | null } : {}),
      ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
      ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
      ...(typeof value.width === 'number' ? { width: value.width } : {}),
      ...(typeof value.height === 'number' ? { height: value.height } : {}),
      ...(typeof value.durationSeconds === 'number' ? { durationSeconds: value.durationSeconds } : {}),
      ...(typeof value.metadataJson === 'string' ? { metadataJson: value.metadataJson } : {})
    }
  } catch {
    return {}
  }
}

export function writeGeneratedVideoSidecar(videoPath: string, facts: GeneratedVideoSidecar): void {
  const destination = generatedVideoSidecarPath(videoPath)
  const temporary = `${destination}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...readGeneratedVideoSidecar(videoPath), ...facts }))
    fs.renameSync(temporary, destination)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}
