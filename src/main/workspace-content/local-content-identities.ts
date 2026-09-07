import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  projectWorkspaceContentAttachmentByteIdentities,
  projectWorkspaceContentPortableAttachmentIdentities,
  type MessageRecord,
  type WorkspaceContentAttachmentIdentityFailure,
  type WorkspaceContentAttachmentLocationInput
} from '@offgrid/application'

export interface RetainedLocalContentIdentities {
  readonly contentIds: ReadonlySet<string>
  readonly filePaths: ReadonlySet<string>
}

export type RetainedLocalContentIdentityOutcome =
  | { readonly ok: true; readonly value: RetainedLocalContentIdentities }
  | { readonly ok: false; readonly failure: WorkspaceContentAttachmentIdentityFailure }

export class DesktopAttachmentIdentityError extends Error {
  constructor(readonly failure: WorkspaceContentAttachmentIdentityFailure) {
    super(failure.message)
    this.name = 'DesktopAttachmentIdentityError'
  }
}

function localFilePath(uri: string): string | null {
  try {
    if (uri.startsWith('file://')) return fileURLToPath(uri)
    return path.isAbsolute(uri) ? path.normalize(uri) : null
  } catch {
    return null
  }
}

function compatibilityInput(
  location: NonNullable<NonNullable<MessageRecord['local']>['contentLocations']>[number]
): WorkspaceContentAttachmentLocationInput {
  return location.contentId === undefined
    ? { kind: 'legacy_index', location }
    : { kind: 'canonical', location }
}

/** Decode Shared-owned portable and legacy byte identity before destructive I/O. */
export function retainedLocalContentIdentities(
  messages: readonly MessageRecord[]
): RetainedLocalContentIdentityOutcome {
  const contentIds = new Set<string>()
  const filePaths = new Set<string>()
  for (const message of messages) {
    const content = message.portable.content
    if (typeof content === 'string') {
      if (message.local?.contentLocations?.length) {
        return {
          ok: false,
          failure: {
            kind: 'missing_identity',
            locationIndex: 0,
            message: 'A retained message has local bytes without portable content identity.'
          }
        }
      }
      continue
    }
    const portable = projectWorkspaceContentPortableAttachmentIdentities(message.portable)
    if (!portable.ok) return portable
    for (const identity of portable.value) contentIds.add(identity.contentId)
    const local = projectWorkspaceContentAttachmentByteIdentities({
      portable: message.portable,
      locations: (message.local?.contentLocations ?? []).map(compatibilityInput)
    })
    if (!local.ok) return local
    for (const identity of local.value) {
      if (identity.uri === undefined) continue
      const filePath = localFilePath(identity.uri)
      if (!filePath) {
        return {
          ok: false,
          failure: {
            kind: 'missing_identity',
            locationIndex: identity.partIndex,
            message: 'A retained attachment has an invalid local byte location.'
          }
        }
      }
      filePaths.add(filePath)
    }
  }
  return { ok: true, value: { contentIds, filePaths } }
}
