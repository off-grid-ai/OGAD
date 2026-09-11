import path from 'node:path'
import crypto from 'node:crypto'
import { BundleError, type FileMapper, type FileRef } from '@offgrid/sync/portable'
import type { DesktopBackupData, DesktopBackupDocument } from './types'
import {
  projectWorkspaceContentAttachmentByteIdentities,
  projectWorkspaceContentPortableAttachmentIdentities,
  type MessageRecord,
  type WorkspaceContentAttachmentIdentityFailure,
  type WorkspaceContentAttachmentLocationInput
} from '@offgrid/application'

type CanonicalBackupData = DesktopBackupData & {
  workspaceContent?: { messages: readonly MessageRecord[] }
}

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

type BackupAttachmentIdentity =
  | { readonly version: 1; readonly kind: 'content_id'; readonly contentId: string }
  | { readonly version: 1; readonly kind: 'legacy_index'; readonly index: number }

function attachmentIdentityLabel(identity: BackupAttachmentIdentity): string {
  return identity.kind === 'content_id'
    ? `content-${identity.contentId}`
    : `legacy-v1-index-${String(identity.index)}`
}

function messageContentKey(
  messageId: string,
  identity: BackupAttachmentIdentity,
  sourcePath: string
): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(['desktop-backup-attachment-v2', messageId, identity]))
    .digest('hex')
  return `files/messages/${safeSegment(messageId)}/${safeSegment(attachmentIdentityLabel(identity))}-${digest}-${safeSegment(path.basename(sourcePath))}`
}

export class DesktopBackupAttachmentIdentityError extends BundleError {
  constructor(readonly failure: WorkspaceContentAttachmentIdentityFailure) {
    super(failure.message)
    this.name = 'DesktopBackupAttachmentIdentityError'
  }
}

const locationInput = (
  location: NonNullable<NonNullable<MessageRecord['local']>['contentLocations']>[number]
): WorkspaceContentAttachmentLocationInput =>
  location.contentId === undefined
    ? { kind: 'legacy_index', location }
    : { kind: 'canonical', location }

const backupIdentity = (
  input: WorkspaceContentAttachmentLocationInput,
  contentId: string
): BackupAttachmentIdentity =>
  input.kind === 'canonical'
    ? { version: 1, kind: 'content_id', contentId }
    : { version: 1, kind: 'legacy_index', index: input.location.index }

function mapMessageLocations(
  data: DesktopBackupData,
  map: (messageId: string, keyIdentity: BackupAttachmentIdentity, uri: string) => string
): DesktopBackupData {
  const canonical = data as CanonicalBackupData
  if (!canonical.workspaceContent) return data
  return {
    ...data,
    workspaceContent: {
      ...canonical.workspaceContent,
      messages: canonical.workspaceContent.messages.map((message) => {
        const portable = projectWorkspaceContentPortableAttachmentIdentities(message.portable)
        if (!portable.ok) throw new DesktopBackupAttachmentIdentityError(portable.failure)
        const locations = message.local?.contentLocations
        if (!locations) return message
        const inputs = locations.map(locationInput)
        const projected = projectWorkspaceContentAttachmentByteIdentities({
          portable: message.portable,
          locations: inputs
        })
        if (!projected.ok) throw new DesktopBackupAttachmentIdentityError(projected.failure)
        return {
          ...message,
          local: {
            ...message.local,
            contentLocations: locations.map((location, index) => ({
              ...location,
              ...(location.uri
                ? {
                    uri: map(
                      message.id,
                      backupIdentity(inputs[index]!, projected.value[index]!.contentId),
                      location.uri
                    )
                  }
                : {})
            }))
          }
        }
      })
    }
  } as DesktopBackupData
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
    const keyed = mapMessageLocations({ ...data, projects }, (messageId, identity, uri) => {
      const key = messageContentKey(messageId, identity, uri)
      files.push({ key, sourcePath: uri })
      return key
    })
    return { files, keyed }
  }

  listKeys(keyed: DesktopBackupData): string[] {
    const keys = keyed.projects.flatMap((project) =>
      project.documents.map((document) => document.path)
    )
    mapMessageLocations(keyed, (_messageId, _index, uri) => {
      keys.push(uri)
      return uri
    })
    for (const key of keys) {
      if (!isSafeBackupKey(key)) {
        throw new BundleError('This backup contains an unsafe file path.')
      }
    }
    return keys
  }

  restore(keyed: DesktopBackupData, keyToPath: Record<string, string>): DesktopBackupData {
    const documentsRestored = {
      ...keyed,
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
    return mapMessageLocations(documentsRestored, (_messageId, _index, uri) => {
      const restoredPath = keyToPath[uri]
      if (!restoredPath) throw new BundleError(`This backup is missing ${uri}.`)
      return restoredPath
    })
  }
}
