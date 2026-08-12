import crypto from 'node:crypto'
import type Database from 'better-sqlite3-multiple-ciphers'
import type { BackupDataPort } from '@offgrid/sync/portable'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from '../sync-mutation'
import {
  validateDesktopBackupData,
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
  /**
   * @param embed Turns a chunk of restored text into a vector. Defaulted to the same MiniLM the RAG indexer
   *   uses (loaded lazily, so a restore that never touches documents does not pull the model in), and injectable
   *   so a test can supply a deterministic one.
   */
  constructor(
    private readonly db: Database.Database,
    private readonly embed: (text: string) => Promise<number[]> = async (text) => {
      const { embeddings } = await import('../embeddings')
      return embeddings.generateEmbedding(text)
    }
  ) {}

  /**
   * Vectors for every chunk in the archive, computed BEFORE the write transaction.
   *
   * Restored chunks used to land with embedding = NULL, and retrieval requires a non-null embedding
   * (rag/store.ts: "WHERE d.enabled = 1 AND c.embedding IS NOT NULL"). Nothing re-embedded them either - the
   * background backfill feeds universal search from observations, frames and transcripts, never rag_chunks. So a
   * restored document appeared enabled in its project and could never inform an answer, permanently.
   *
   * The archive carries no vectors (DesktopBackupChunk is content + position), so they have to be recomputed
   * here. Computed up front because better-sqlite3 transactions are synchronous and cannot await.
   *
   * A model that is unavailable does not fail the restore: those chunks keep their null and the document lands
   * as it did before this change, which is a worse outcome than being embedded but a much better one than
   * losing the restore entirely.
   */
  private async embedArchiveChunks(
    data: DesktopBackupData
  ): Promise<Map<string, string | null>> {
    const vectors = new Map<string, string | null>()
    for (const project of data.projects) {
      for (const document of project.documents) {
        for (const chunk of document.chunks) {
          const key = `${project.id}#${document.path}#${chunk.position}`
          try {
            const vector = await this.embed(chunk.content)
            vectors.set(key, vector.length > 0 ? JSON.stringify(vector) : null)
          } catch {
            vectors.set(key, null)
          }
        }
      }
    }
    return vectors
  }

  async collectAll(): Promise<DesktopBackupData> {
    return this.collect()
  }

  async collectProject(projectId: string): Promise<DesktopBackupData | null> {
    const project = this.project(projectId, true)
    if (!project) return null
    return {
      surface: 'offgrid-desktop',
      projects: [project],
      conversations: this.conversations(projectId)
    }
  }

  async collectConversation(conversationId: string): Promise<DesktopBackupData | null> {
    const conversation = this.conversation(conversationId)
    if (!conversation) return null
    const project = conversation.projectId ? this.project(conversation.projectId, false) : null
    return {
      surface: 'offgrid-desktop',
      projects: project ? [project] : [],
      conversations: [conversation]
    }
  }

  validate(data: unknown): DesktopBackupData {
    return validateDesktopBackupData(data)
  }

  async apply(data: DesktopBackupData): Promise<DesktopRestoreSummary> {
    const addedProjects: string[] = []
    const addedConversations: string[] = []
    const addedMessages: string[] = []
    let documentsAdded = 0
    const chunkVectors = await this.embedArchiveChunks(data)

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
          const result = this.db
            .prepare(
              `INSERT INTO rag_documents
                (project_id, name, path, size, kind, enabled, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              project.id,
              document.name,
              document.path,
              document.size,
              document.kind,
              document.enabled ? 1 : 0,
              document.createdAt
            )
          const documentId = Number(result.lastInsertRowid)
          const insertChunk = this.db.prepare(
            `INSERT INTO rag_chunks (doc_id, content, position, embedding)
             VALUES (?, ?, ?, ?)`
          )
          for (const chunk of document.chunks) {
            insertChunk.run(
              documentId,
              chunk.content,
              chunk.position,
              chunkVectors.get(`${project.id}#${document.path}#${chunk.position}`) ?? null
            )
          }
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
            alreadyHere.get(
              conversation.id,
              message.role,
              message.content,
              message.createdAt
            ) !== undefined
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
          addedMessages.push(uuid)
        }
      }
    })
    applyTransaction()

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

  private collect(): DesktopBackupData {
    const projects = (
      this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[]
    ).map((row) => this.mapProject(row, true))
    return {
      surface: 'offgrid-desktop',
      projects,
      conversations: this.conversations()
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
              `SELECT id, project_id, name, path, size, kind, enabled, created_at
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

  private mapDocument(row: DocumentRow): DesktopBackupDocument {
    const chunks = this.db
      .prepare('SELECT content, position FROM rag_chunks WHERE doc_id = ? ORDER BY position ASC')
      .all(row.id) as Array<{ content: string; position: number }>
    return {
      name: row.name,
      path: row.path,
      size: row.size,
      kind: row.kind,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      chunks
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
