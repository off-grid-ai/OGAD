import {
  readGeneratedVideoReference,
  withGeneratedVideoReference
} from '../../shared/generated-video-reference'
import path from 'node:path'
import crypto from 'node:crypto'
import { BundleError, type FileMapper, type FileRef } from '@offgrid/sync/portable'
import type { DesktopBackupData, DesktopBackupDocument } from './types'

const safeSegment = (value: string): string => {
  const normalized = value.normalize('NFKC').replaceAll(/[^a-zA-Z0-9._-]/g, '_')
  return normalized.replaceAll(/^\.+|\.+$/g, '') || 'file'
}

function documentKey(projectId: string, index: number, document: DesktopBackupDocument): string {
  const identity = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([projectId, document.name, document.size, document.kind, document.createdAt])
    )
    .digest('hex')
    .slice(0, 16)
  return `files/documents/${safeSegment(projectId)}/${String(index)}-${identity}-${safeSegment(path.basename(document.path) || document.name)}`
}

export function isSafeBackupKey(value: string): boolean {
  if (!value.startsWith('files/')) return false
  if (value.includes('\\') || value.includes('\0')) return false
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

export class DesktopBackupFileMapper implements FileMapper<DesktopBackupData> {
  extract(data: DesktopBackupData): { files: FileRef[]; keyed: DesktopBackupData } {
    const files: FileRef[] = []
    const projects = data.projects.map((project) => ({
      ...project,
      documents: project.documents.map((document, index) => {
        const key = documentKey(project.id, index, document)
        files.push({ key, sourcePath: document.path })
        return { ...document, path: key }
      })
    }))
    const videos = (data.videos ?? []).map((video) => {
      const digest = crypto.createHash('sha256').update(video.originalPath).digest('hex')
      const key = `files/videos/${digest}.mp4`
      files.push({ key, sourcePath: video.path })
      return { ...video, path: key }
    })
    return { files, keyed: { ...data, projects, videos } }
  }

  listKeys(keyed: DesktopBackupData): string[] {
    const keys = keyed.projects.flatMap((project) =>
      project.documents.map((document) => document.path)
    )
    keys.push(...(keyed.videos ?? []).map((video) => video.path))
    for (const key of keys) {
      if (!isSafeBackupKey(key)) {
        throw new BundleError('This backup contains an unsafe file path.')
      }
    }
    return keys
  }

  restore(keyed: DesktopBackupData, keyToPath: Record<string, string>): DesktopBackupData {
    const videos = (keyed.videos ?? []).map((video) => {
      const restored = keyToPath[video.path]
      if (!restored) throw new BundleError(`This backup is missing ${video.path}.`)
      return { ...video, path: restored }
    })
    const paths = new Map(videos.map((video) => [video.originalPath, video.path]))
    return {
      ...keyed,
      videos,
      conversations: keyed.conversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => {
          const reference = readGeneratedVideoReference(message.context)
          const restored = reference && paths.get(reference.path)
          return restored
            ? {
                ...message,
                context: withGeneratedVideoReference(message.context as Record<string, unknown>, {
                  ...reference,
                  path: restored
                })
              }
            : message
        })
      })),
      projects: keyed.projects.map((project) => ({
        ...project,
        documents: project.documents.map((document) => {
          const restoredPath = keyToPath[document.path]
          if (!restoredPath) {
            throw new BundleError(`This backup is missing ${document.path}.`)
          }
          return { ...document, path: restoredPath }
        })
      }))
    }
  }
}
