import type {
  ProjectRecord,
  WorkspaceContentFailure,
  WorkspaceContentOutcome
} from '@offgrid/application'
import { IconFile, IconFileText, IconMicrophone, IconMovie, IconPhoto } from '@tabler/icons-react'

export const PROJECT_KIND_ICON: Record<string, typeof IconFile> = {
  text: IconFileText,
  pdf: IconFile,
  docx: IconFileText,
  image: IconPhoto,
  video: IconMovie,
  audio: IconMicrophone
}

export function describeWorkspaceContentFailure(failure: WorkspaceContentFailure): string {
  switch (failure.kind) {
    case 'not_ready':
      return `Workspace content is not ready yet. ${failure.message}`
    case 'invalid_input':
      return failure.message
    case 'not_found':
      return `That ${failure.entity.replace('_', ' ')} no longer exists. ${failure.message}`
    case 'conflict':
      return `This was changed somewhere else. ${failure.message}`
    case 'persistence':
      return `Could not save the change. ${failure.message}`
  }
}

export function fmtSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function knowledgeBaseFailure(name: string, action: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return `${name}: ${action} failed. ${detail}`
}

export function createdProjectId(
  outcome: Extract<WorkspaceContentOutcome, { ok: true }>
): string | null {
  for (const change of outcome.value.changes) {
    if (change.kind === 'put' && change.entity === 'project') return change.record.id
  }
  return null
}

export function resolveActiveId(
  selectedProjectId: string | null | undefined,
  localActiveId: string | null,
  projects: readonly ProjectRecord[]
): string | null {
  return selectedProjectId ?? localActiveId ?? projects[0]?.id ?? null
}
