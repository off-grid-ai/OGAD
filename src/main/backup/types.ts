import { BundleError } from '@offgrid/sync/portable'

export interface DesktopBackupChunk {
  content: string
  position: number
}

export interface DesktopBackupDocument {
  name: string
  path: string
  size: number
  kind: string
  enabled: boolean
  createdAt: string
  chunks: DesktopBackupChunk[]
}

export interface DesktopBackupProject {
  id: string
  name: string
  description: string
  systemPrompt: string
  icon?: string
  includeMemory: boolean
  createdAt: string
  updatedAt: string
  documents: DesktopBackupDocument[]
}

export interface DesktopBackupMessage {
  role: 'user' | 'assistant'
  content: string
  context?: unknown
  createdAt: string
}

export interface DesktopBackupConversation {
  id: string
  title: string | null
  projectId: string | null
  createdAt: string
  updatedAt: string
  messages: DesktopBackupMessage[]
}

export interface DesktopBackupData {
  surface: 'offgrid-desktop'
  projects: DesktopBackupProject[]
  conversations: DesktopBackupConversation[]
}

export interface DesktopRestoreSummary {
  projectsAdded: number
  conversationsAdded: number
  messagesAdded: number
  documentsAdded: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

function isChunk(value: unknown): value is DesktopBackupChunk {
  return (
    isRecord(value) &&
    isString(value.content) &&
    Number.isInteger(value.position) &&
    Number(value.position) >= 0
  )
}

function isDocument(value: unknown): value is DesktopBackupDocument {
  return (
    isRecord(value) &&
    isString(value.name) &&
    isString(value.path) &&
    typeof value.size === 'number' &&
    Number.isFinite(value.size) &&
    value.size >= 0 &&
    isString(value.kind) &&
    typeof value.enabled === 'boolean' &&
    isString(value.createdAt) &&
    Array.isArray(value.chunks) &&
    value.chunks.every(isChunk)
  )
}

function isProject(value: unknown): value is DesktopBackupProject {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.description) &&
    isString(value.systemPrompt) &&
    (value.icon === undefined || isString(value.icon)) &&
    typeof value.includeMemory === 'boolean' &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    Array.isArray(value.documents) &&
    value.documents.every(isDocument)
  )
}

function isMessage(value: unknown): value is DesktopBackupMessage {
  return (
    isRecord(value) &&
    (value.role === 'user' || value.role === 'assistant') &&
    isString(value.content) &&
    isString(value.createdAt)
  )
}

function isConversation(value: unknown): value is DesktopBackupConversation {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isNullableString(value.title) &&
    isNullableString(value.projectId) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage)
  )
}

export function validateDesktopBackupData(value: unknown): DesktopBackupData {
  if (
    !isRecord(value) ||
    value.surface !== 'offgrid-desktop' ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    !Array.isArray(value.conversations) ||
    !value.conversations.every(isConversation)
  ) {
    throw new BundleError('This backup does not contain valid Off Grid AI Desktop data.')
  }
  return value as unknown as DesktopBackupData
}
