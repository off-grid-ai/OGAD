import fs from 'node:fs'
import path from 'node:path'
import { generatedVideosDir, listGeneratedVideos } from '../generated-videos/library'
import {
  readGeneratedVideoSidecar,
  writeGeneratedVideoSidecar
} from '../generated-videos/gallery-sidecar'
import {
  readGeneratedVideoReference,
  withGeneratedVideoReference
} from '../../shared/generated-video-reference'
import crypto from 'node:crypto'
import type Database from 'better-sqlite3-multiple-ciphers'
import type { BackupDataPort } from '@offgrid/sync/portable'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from '../sync-mutation'
import { DOCUMENT_SCHEMA_VERSION } from '@offgrid/rag/documents'
import { ensureAttachedDocumentSchema } from '../documents/sqlite-store'
import {
  validateDesktopBackupData,
  type DesktopBackupAttachedDocument,
  type DesktopBackupConversation,
  type DesktopBackupData,
  type DesktopBackupDocument,
  type DesktopBackupMessage,
  type DesktopBackupProject,
  type DesktopRestoreSummary
} from './types'

interface ProjectRow {
  id: string
  name: string
  description: string
  system_prompt: string
  icon: string | null
  include_memory: number
  created_at: string
  updated_at: string
}

interface DocumentRow {
  id: number
  project_id: string
  name: string
  path: string
  size: number
  kind: string
  enabled: number
  created_at: string
  document_id: string | null
}

interface ConversationRow {
  id: string
  title: string | null
  project_id: string | null
  created_at: string
  updated_at: string
}

interface MessageRow {
  role: 'user' | 'assistant'
  content: string
  context: string | null
  created_at: string
}

const parseContext = (value: string | null): unknown => {
  if (!value) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

export class DesktopBackupDataPort implements BackupDataPort<
  DesktopBackupData,
  DesktopRestoreSummary
> {
  constructor(private readonly db: Database.Database) {}

  async collectAll(): Promise<DesktopBackupData> {
    return this.collect()
  }

  async collectProject(projectId: string): Promise<DesktopBackupData | null> {
    const project = this.project(projectId, true)
    if (!project) return null
    const conversations = this.conversations(projectId)
    return {
      surface: 'offgrid-desktop',
      projects: [project],
      videos: this.videos({ projectId }),
      conversations,
      attachedDocuments: this.attachedDocuments(conversations, [project])
    }
  }

  async collectConversation(conversationId: string): Promise<DesktopBackupData | null> {
    const conversation = this.conversation(conversationId)
    if (!conversation) return null
    const project = conversation.projectId ? this.project(conversation.projectId, false) : null
    return {
      surface: 'offgrid-desktop',
      projects: project ? [project] : [],
      videos: this.videos({ conversationId }),
      conversations: [conversation],
      attachedDocuments: this.attachedDocuments([conversation])
    }
  }

  validate(data: unknown): DesktopBackupData {
    return validateDesktopBackupData(data)
  }

  async apply(data: DesktopBackupData): Promise<DesktopRestoreSummary> {
    const restoredPaths = new Map<string, string>()
    for (const video of data.videos ?? []) {
      // The mapper supplies archive-owned paths. Never use a peer's original path as a destination.
      const root = generatedVideosDir()
      fs.mkdirSync(root, { recursive: true })
      const identity = crypto.createHash('sha256').update(video.originalPath).digest('hex')
      const destination = path.join(root, `restored-${identity}.mp4`)
      if (
        fs.existsSync(destination) &&
        (!fs.lstatSync(destination).isFile() || fs.lstatSync(destination).isSymbolicLink())
      ) {
        throw new Error('The restored video destination is not an app-owned file.')
      }
      if (!fs.existsSync(destination))
        fs.copyFileSync(video.path, destination, fs.constants.COPYFILE_EXCL)
      writeGeneratedVideoSidecar(destination, video.metadata)
      restoredPaths.set(video.path, destination)
    }
    data = {
      ...data,
      conversations: data.conversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => {
          const reference = readGeneratedVideoReference(message.context)
          const destination = reference && restoredPaths.get(reference.path)
          return destination
            ? {
                ...message,
                context: withGeneratedVideoReference(message.context as Record<string, unknown>, {
                  ...reference,
                  path: destination
                })
              }
            : message
        })
      }))
    }
    const addedProjects: string[] = []
    const addedConversations: string[] = []
    const addedMessages: string[] = []
    let documentsAdded = 0
    // Archives from before the document index carry knowledge-base text as chunks: it is restored
    // as an indexed document under the hash of that text.
    const legacyDocuments: DesktopBackupAttachedDocument[] = []

    const applyTransaction = this.db.transaction(() => {
      for (const project of data.projects) {
        const exists = this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(project.id)
        if (!exists) {
          this.db
            .prepare(
              `INSERT INTO projects
                (id, name, description, system_prompt, icon, include_memory, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              project.id,
              project.name,
              project.description,
              project.systemPrompt,
              project.icon ?? null,
              project.includeMemory ? 1 : 0,
              project.createdAt,
              project.updatedAt
            )
          addedProjects.push(project.id)
        }

        for (const document of project.documents) {
          if (this.documentExists(project.id, document)) continue
          let documentId = document.documentId ?? null
          if (!documentId && document.chunks.length) {
            const text = [...document.chunks]
              .sort((a, b) => a.position - b.position)
              .map((chunk) => chunk.content)
              .join('\n\n')
            documentId = crypto.createHash('sha256').update(text, 'utf8').digest('hex')
            legacyDocuments.push({
              id: documentId,
              name: document.name,
              kind: 'text',
              pages: [{ page: 1, text }]
            })
          }
          this.db
            .prepare(
              `INSERT INTO rag_documents
                (sync_id, project_id, name, path, size, kind, enabled, document_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              crypto.randomUUID(),
              project.id,
              document.name,
              document.path,
              document.size,
              document.kind,
              document.enabled ? 1 : 0,
              documentId,
              document.createdAt
            )
          documentsAdded += 1
        }
      }

      for (const conversation of data.conversations) {
        // An EXISTING conversation is no longer skipped whole. A restore is additive, and a conversation that
        // already exists here - synced from another device, or half-restored by an earlier run - can still be
        // missing messages the archive holds. Skipping it dropped them silently, so a restore could report
        // success and leave an incomplete history.
        const exists =
          this.db.prepare('SELECT 1 FROM rag_conversations WHERE id = ?').get(conversation.id) !==
          undefined
        const projectId =
          conversation.projectId &&
          this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(conversation.projectId)
            ? conversation.projectId
            : null
        if (!exists) {
          this.db
            .prepare(
              `INSERT INTO rag_conversations (id, title, project_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(
              conversation.id,
              conversation.title,
              projectId,
              conversation.createdAt,
              conversation.updatedAt
            )
          addedConversations.push(conversation.id)
        }

        const insertMessage = this.db.prepare(
          `INSERT INTO rag_messages
            (uuid, conversation_id, role, content, context, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        // The archive carries no message id (role, content, context, createdAt - see DesktopBackupMessage), so
        // identity has to come from the content itself. Same conversation, same role, same text, same timestamp
        // IS the same message; matching on that is what lets an additive restore fill gaps without producing a
        // second copy of everything the user already has.
        const alreadyHere = this.db.prepare(
          `SELECT 1 FROM rag_messages
           WHERE conversation_id = ? AND role = ? AND content = ? AND created_at = ?`
        )
        for (const message of conversation.messages) {
          if (
            exists &&
            alreadyHere.get(conversation.id, message.role, message.content, message.createdAt) !==
              undefined
          ) {
            continue
          }
          const uuid = crypto.randomUUID()
          insertMessage.run(
            uuid,
            conversation.id,
            message.role,
            message.content,
            message.context === undefined ? null : JSON.stringify(message.context),
            message.createdAt
          )
          const video = readGeneratedVideoReference(message.context)
          if (video && [...restoredPaths.values()].includes(video.path)) {
            writeGeneratedVideoSidecar(video.path, {
              messageId: uuid,
              conversationId: conversation.id,
              projectId: conversation.projectId
            })
          }
          addedMessages.push(uuid)
        }
      }
    })
    applyTransaction()

    this.restoreAttachedDocuments([...(data.attachedDocuments ?? []), ...legacyDocuments])
    for (const projectId of addedProjects) {
      emitSyncMutation({ entity: CORE_SYNC_ENTITIES.project, entityId: projectId, kind: 'put' })
    }
    for (const conversationId of addedConversations) {
      emitSyncMutation({
        entity: CORE_SYNC_ENTITIES.conversation,
        entityId: conversationId,
        kind: 'put'
      })
    }
    for (const messageId of addedMessages) {
      emitSyncMutation({ entity: CORE_SYNC_ENTITIES.message, entityId: messageId, kind: 'put' })
    }

    return {
      projectsAdded: addedProjects.length,
      conversationsAdded: addedConversations.length,
      messagesAdded: addedMessages.length,
      documentsAdded
    }
  }

  private videos(scope?: {
    conversationId?: string
    projectId?: string
  }): { path: string; originalPath: string; metadata: Record<string, unknown> }[] {
    return listGeneratedVideos(scope).map((video) => ({
      path: video.path,
      originalPath: video.path,
      metadata: { ...readGeneratedVideoSidecar(video.path) }
    }))
  }

  private collect(): DesktopBackupData {
    const projects = (
      this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[]
    ).map((row) => this.mapProject(row, true))
    const conversations = this.conversations()
    return {
      surface: 'offgrid-desktop',
      projects,
      videos: this.videos(),
      conversations,
      attachedDocuments: this.attachedDocuments(conversations, projects)
    }
  }

  private project(projectId: string, includeDocuments: boolean): DesktopBackupProject | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | ProjectRow
      | undefined
    return row ? this.mapProject(row, includeDocuments) : null
  }

  private mapProject(row: ProjectRow, includeDocuments: boolean): DesktopBackupProject {
    const documents = includeDocuments
      ? (
          this.db
            .prepare(
              `SELECT id, project_id, name, path, size, kind, enabled, created_at, document_id
               FROM rag_documents WHERE project_id = ? ORDER BY created_at ASC`
            )
            .all(row.id) as DocumentRow[]
        ).map((document) => this.mapDocument(document))
      : []
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      systemPrompt: row.system_prompt,
      icon: row.icon ?? undefined,
      includeMemory: row.include_memory === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      documents
    }
  }

  /** A knowledge-base file; its text travels with the archive's attached documents. */
  private mapDocument(row: DocumentRow): DesktopBackupDocument {
    return {
      name: row.name,
      path: row.path,
      size: row.size,
      kind: row.kind,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      chunks: [],
      ...(row.document_id ? { documentId: row.document_id } : {})
    }
  }

  private conversations(projectId?: string): DesktopBackupConversation[] {
    const rows = (
      projectId === undefined
        ? this.db
            .prepare(
              `SELECT id, title, project_id, created_at, updated_at
               FROM rag_conversations ORDER BY updated_at ASC`
            )
            .all()
        : this.db
            .prepare(
              `SELECT id, title, project_id, created_at, updated_at
               FROM rag_conversations WHERE project_id = ? ORDER BY updated_at ASC`
            )
            .all(projectId)
    ) as ConversationRow[]
    return rows.map((row) => this.mapConversation(row))
  }

  private conversation(conversationId: string): DesktopBackupConversation | null {
    const row = this.db
      .prepare(
        `SELECT id, title, project_id, created_at, updated_at
         FROM rag_conversations WHERE id = ?`
      )
      .get(conversationId) as ConversationRow | undefined
    return row ? this.mapConversation(row) : null
  }

  private mapConversation(row: ConversationRow): DesktopBackupConversation {
    const messages = this.db
      .prepare(
        `SELECT role, content, context, created_at
         FROM rag_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`
      )
      .all(row.id) as MessageRow[]
    return {
      id: row.id,
      title: row.title,
      projectId: row.project_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: messages.map(
        (message): DesktopBackupMessage => ({
          role: message.role,
          content: message.content,
          context: parseContext(message.context),
          createdAt: message.created_at
        })
      )
    }
  }

  /**
   * The page text of documents the exported messages attach and the exported knowledge bases hold.
   * Vectors and passages are not kept: the next chat turn re-indexes from the text.
   */
  private attachedDocuments(
    conversations: DesktopBackupConversation[],
    projects: DesktopBackupProject[] = []
  ): DesktopBackupAttachedDocument[] {
    const ids = new Set<string>()
    for (const project of projects)
      for (const document of project.documents) if (document.documentId) ids.add(document.documentId)
    for (const conversation of conversations) {
      for (const message of conversation.messages) {
        const attachments = (message.context as { attachments?: unknown } | null | undefined)?.attachments
        if (!Array.isArray(attachments)) continue
        for (const attachment of attachments) {
          const id = (attachment as { documentId?: unknown } | null)?.documentId
          if (typeof id === 'string' && id) ids.add(id)
        }
      }
    }
    if (!ids.size) return []
    try {
      const documentRow = this.db.prepare('SELECT id, name, kind FROM attached_documents WHERE id = ?')
      const pageRows = this.db.prepare(
        'SELECT page, label, text FROM attached_document_pages WHERE document_id = ? ORDER BY page'
      )
      return [...ids].flatMap((id) => {
        const row = documentRow.get(id) as { id: string; name: string; kind: string } | undefined
        if (!row) return []
        const pages = (pageRows.all(id) as { page: number; label: string | null; text: string }[]).map(
          (page) => ({ page: page.page, ...(page.label ? { label: page.label } : {}), text: page.text })
        )
        return [{ id: row.id, name: row.name, kind: row.kind, pages }]
      })
    } catch {
      // No document has been attached on this device yet: the tables do not exist.
      return []
    }
  }

  private restoreAttachedDocuments(documents: DesktopBackupAttachedDocument[]): void {
    if (!documents.length) return
    ensureAttachedDocumentSchema(this.db)
    const exists = this.db.prepare('SELECT 1 FROM attached_documents WHERE id = ?')
    const insertDocument = this.db.prepare(
      `INSERT INTO attached_documents (id, name, kind, state, page_count, chunk_count, embedded_count,
         unreadable_pages, embedder, schema_version, created_at, last_used_at)
       VALUES (?, ?, ?, 'indexing', ?, 0, 0, 0, 'none', ?, ?, ?)`
    )
    const insertPage = this.db.prepare(
      'INSERT OR REPLACE INTO attached_document_pages (document_id, page, label, text, needs_ocr) VALUES (?, ?, ?, ?, 0)'
    )
    const now = Date.now()
    this.db.transaction(() => {
      for (const document of documents) {
        if (exists.get(document.id)) continue
        insertDocument.run(document.id, document.name, document.kind, document.pages.length, DOCUMENT_SCHEMA_VERSION, now, now)
        for (const page of document.pages) insertPage.run(document.id, page.page, page.label ?? null, page.text)
      }
    })()
  }

  private documentExists(projectId: string, document: DesktopBackupDocument): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM rag_documents
           WHERE project_id = ? AND name = ? AND size = ? LIMIT 1`
        )
        .get(projectId, document.name, document.size)
    )
  }
}
