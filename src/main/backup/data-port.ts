import crypto from 'node:crypto'
import type Database from 'better-sqlite3-multiple-ciphers'
import { BundleError, type BackupDataPort } from '@offgrid/sync/portable'
import type {
  ChatTurnRecord,
  ConversationRecord,
  MessageRecord,
  ProjectRecord,
  WorkspaceContentFacade,
  WorkspaceContentRepositorySnapshot
} from '@offgrid/application'
import { parseSyncedMessageContext } from '@offgrid/sync'
import { BackupRestoreAdmission } from './restore-admission'
import {
  validateDesktopBackupData,
  type DesktopBackupConversation,
  type DesktopBackupData,
  type DesktopBackupDocument,
  type DesktopBackupProject,
  type DesktopRestoreSummary
} from './types'

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

interface CanonicalBackupContent {
  projects: readonly ProjectRecord[]
  conversations: readonly ConversationRecord[]
  messages: readonly MessageRecord[]
  chatTurns: readonly ChatTurnRecord[]
}

interface CanonicalDesktopBackupData extends DesktopBackupData {
  workspaceContent?: CanonicalBackupContent
}

type RestoreIntent = {
  id: string
  phase: 'preparing' | 'workspace_content' | 'documents' | 'completed'
  data: DesktopBackupData
  vectors: [string, string | null][]
  before: { projects: number; conversations: number; messages: number }
}

const contentCounts = (snapshot: WorkspaceContentRepositorySnapshot): RestoreIntent['before'] => ({
  projects: snapshot.projects.length,
  conversations: snapshot.conversations.length,
  messages: snapshot.messages.length
})

interface DesktopBackupDataPortOptions {
  readonly workspaceContent: WorkspaceContentFacade
  readonly restoreAdmission: BackupRestoreAdmission
  readonly embed?: (text: string) => Promise<number[]>
}

export class DesktopBackupDataPort implements BackupDataPort<
  DesktopBackupData,
  DesktopRestoreSummary
> {
  constructor(
    private readonly db: Database.Database,
    private readonly options: DesktopBackupDataPortOptions
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS backup_restore_intents (
      id TEXT PRIMARY KEY, phase TEXT NOT NULL, data_json TEXT NOT NULL,
      vectors_json TEXT NOT NULL, before_json TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
  }

  /** Compute archive vectors before the synchronous SQLite write transaction. */
  private async embedArchiveChunks(data: DesktopBackupData): Promise<Map<string, string | null>> {
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

  private async embed(text: string): Promise<number[]> {
    if (this.options.embed) return this.options.embed(text)
    const { embeddings } = await import('../embeddings')
    return embeddings.generateEmbedding(text)
  }

  async collectAll(): Promise<DesktopBackupData> {
    return this.collect()
  }

  async collectProject(projectId: string): Promise<DesktopBackupData | null> {
    const snapshot = this.contentSnapshot()
    const project = this.project(snapshot, projectId, true)
    if (!project) return null
    const conversations = snapshot.conversations.filter((item) => item.projectId === projectId)
    return {
      surface: 'offgrid-desktop',
      projects: [project],
      conversations: this.legacyConversations(snapshot, conversations),
      workspaceContent: this.canonicalContent(
        snapshot,
        [projectId],
        conversations.map(({ id }) => id)
      )
    } as CanonicalDesktopBackupData
  }

  async collectConversation(conversationId: string): Promise<DesktopBackupData | null> {
    const snapshot = this.contentSnapshot()
    const conversation = snapshot.conversations.find((item) => item.id === conversationId)
    if (!conversation) return null
    const project = conversation.projectId
      ? this.project(snapshot, conversation.projectId, false)
      : null
    return {
      surface: 'offgrid-desktop',
      projects: project ? [project] : [],
      conversations: this.legacyConversations(snapshot, [conversation]),
      workspaceContent: this.canonicalContent(snapshot, project ? [project.id] : [], [
        conversationId
      ])
    } as CanonicalDesktopBackupData
  }

  validate(data: unknown): DesktopBackupData {
    const legacy = validateDesktopBackupData(data) as CanonicalDesktopBackupData
    const content = legacy.workspaceContent
    if (
      content !== undefined &&
      (!Array.isArray(content.projects) ||
        !Array.isArray(content.conversations) ||
        !Array.isArray(content.messages) ||
        !Array.isArray(content.chatTurns))
    ) {
      throw new BundleError('This backup has malformed canonical Workspace Content data.')
    }
    return legacy
  }

  async apply(data: DesktopBackupData): Promise<DesktopRestoreSummary> {
    this.validate(data)
    const intent: RestoreIntent = {
      id: crypto.randomUUID(),
      phase: 'preparing',
      data,
      vectors: [],
      before: contentCounts(this.contentSnapshot())
    }
    this.saveIntent(intent)
    await this.resumePending(intent.id)
    intent.before = contentCounts(this.contentSnapshot())
    this.saveIntent(intent)
    return this.resumeIntent(intent)
  }

  admitRestore<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.options.restoreAdmission.admit(operation)
  }

  async resumePending(exceptId?: string): Promise<void> {
    // Older builds retained the full payload after a successful restore. It is no longer recovery
    // state, so remove it before reading the intents that can still resume.
    this.db.prepare("DELETE FROM backup_restore_intents WHERE phase = 'completed'").run()
    const rows = this.db
      .prepare(
        `SELECT id, phase, data_json, vectors_json, before_json FROM backup_restore_intents
         WHERE phase <> 'completed' ORDER BY updated_at ASC`
      )
      .all() as Array<{
      id: string
      phase: RestoreIntent['phase']
      data_json: string
      vectors_json: string
      before_json: string
    }>
    for (const row of rows) {
      if (row.id === exceptId) continue
      await this.resumeIntent({
        id: row.id,
        phase: row.phase,
        data: this.validate(JSON.parse(row.data_json) as unknown),
        vectors: JSON.parse(row.vectors_json) as RestoreIntent['vectors'],
        before: JSON.parse(row.before_json) as RestoreIntent['before']
      })
    }
  }

  private async resumeIntent(intent: RestoreIntent): Promise<DesktopRestoreSummary> {
    if (intent.phase === 'preparing') {
      intent.vectors = [...(await this.embedArchiveChunks(intent.data)).entries()]
      intent.phase = 'workspace_content'
      this.saveIntent(intent)
    }
    const beforeCommit = this.contentSnapshot()
    const incoming = this.backupContent(intent.data)
    const replacement = this.mergeContent(
      beforeCommit,
      incoming,
      (intent.data as CanonicalDesktopBackupData).workspaceContent !== undefined
    )
    if (intent.phase === 'workspace_content') {
      const outcome = await this.options.workspaceContent.execute({
        type: 'replace_workspace_content',
        origin: 'restore',
        ...replacement
      })
      if (!outcome.ok) {
        throw new Error(`Workspace Content restore failed: ${outcome.failure.message}`)
      }
      intent.phase = 'documents'
      this.saveIntent(intent)
    }
    const documentsAdded = this.restoreDocuments(intent.data, new Map(intent.vectors))
    this.deleteIntent(intent.id)

    return {
      projectsAdded: Math.max(0, replacement.projects.length - intent.before.projects),
      conversationsAdded: Math.max(
        0,
        replacement.conversations.length - intent.before.conversations
      ),
      messagesAdded: Math.max(0, replacement.messages.length - intent.before.messages),
      documentsAdded
    }
  }

  private saveIntent(intent: RestoreIntent): void {
    this.db
      .prepare(
        `INSERT INTO backup_restore_intents
         (id, phase, data_json, vectors_json, before_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, data_json=excluded.data_json,
         vectors_json=excluded.vectors_json, before_json=excluded.before_json,
         updated_at=excluded.updated_at`
      )
      .run(
        intent.id,
        intent.phase,
        JSON.stringify(intent.data),
        JSON.stringify(intent.vectors),
        JSON.stringify(intent.before),
        new Date().toISOString()
      )
  }

  private deleteIntent(id: string): void {
    this.db.prepare('DELETE FROM backup_restore_intents WHERE id = ?').run(id)
  }

  private collect(): DesktopBackupData {
    const snapshot = this.contentSnapshot()
    return {
      surface: 'offgrid-desktop',
      projects: snapshot.projects.map((project) => this.mapProject(project, true)),
      conversations: this.legacyConversations(snapshot, snapshot.conversations),
      workspaceContent: this.canonicalContent(
        snapshot,
        snapshot.projects.map(({ id }) => id),
        snapshot.conversations.map(({ id }) => id)
      )
    } as CanonicalDesktopBackupData
  }

  private contentSnapshot(): WorkspaceContentRepositorySnapshot {
    const snapshot = this.options.workspaceContent.snapshot()
    if (snapshot.status !== 'ready') throw new Error('Workspace Content is not ready for backup.')
    return snapshot
  }

  private project(
    snapshot: WorkspaceContentRepositorySnapshot,
    projectId: string,
    includeDocuments: boolean
  ): DesktopBackupProject | null {
    const project = snapshot.projects.find(({ id }) => id === projectId)
    return project ? this.mapProject(project, includeDocuments) : null
  }

  private mapProject(record: ProjectRecord, includeDocuments: boolean): DesktopBackupProject {
    const documents = includeDocuments
      ? (
          this.db
            .prepare(
              `SELECT id, project_id, name, path, size, kind, enabled, created_at
               FROM rag_documents WHERE project_id = ? ORDER BY created_at ASC`
            )
            .all(record.id) as DocumentRow[]
        ).map((document) => this.mapDocument(document))
      : []
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      systemPrompt: record.systemPrompt,
      icon: record.icon,
      includeMemory: record.includeMemory,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
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

  private legacyConversations(
    snapshot: WorkspaceContentRepositorySnapshot,
    conversations: readonly ConversationRecord[]
  ): DesktopBackupConversation[] {
    return conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      projectId: conversation.projectId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: snapshot.messages
        .filter(
          (message) =>
            message.conversationId === conversation.id &&
            (message.portable.role === 'user' || message.portable.role === 'assistant') &&
            typeof message.portable.content === 'string'
        )
        .map((message) => ({
          role: message.portable.role as 'user' | 'assistant',
          content: message.portable.content as string,
          context: message.portable.context,
          createdAt: message.createdAt
        }))
    }))
  }

  private canonicalContent(
    snapshot: WorkspaceContentRepositorySnapshot,
    projectIds: readonly string[],
    conversationIds: readonly string[]
  ): CanonicalBackupContent {
    const projects = new Set(projectIds)
    const conversations = new Set(conversationIds)
    return {
      projects: snapshot.projects.filter(({ id }) => projects.has(id)),
      conversations: snapshot.conversations.filter(({ id }) => conversations.has(id)),
      messages: snapshot.messages.filter(({ conversationId }) => conversations.has(conversationId)),
      chatTurns: snapshot.chatTurns.filter(({ conversationId }) =>
        conversations.has(conversationId)
      )
    }
  }

  private backupContent(data: DesktopBackupData): CanonicalBackupContent {
    const canonical = (data as CanonicalDesktopBackupData).workspaceContent
    if (canonical) return canonical
    const projects: ProjectRecord[] = data.projects.map(
      ({ documents: _documents, ...project }) => project
    )
    const conversations: ConversationRecord[] = data.conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title?.trim() || 'New Conversation',
      modelId: null,
      projectId: conversation.projectId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    }))
    const messages: MessageRecord[] = data.conversations.flatMap((conversation) =>
      conversation.messages.map((message, position) => {
        const identity = crypto
          .createHash('sha256')
          .update(
            JSON.stringify([
              conversation.id,
              position,
              message.role,
              message.content,
              message.createdAt
            ])
          )
          .digest('hex')
        const context = parseSyncedMessageContext(message.context)
        return {
          id: `backup-message-${identity}`,
          conversationId: conversation.id,
          turnId: null,
          position,
          portable: {
            role: message.role,
            content: message.content,
            ...(context ? { context } : {})
          },
          ...(message.context === undefined ? {} : { local: { legacyContext: message.context } }),
          createdAt: message.createdAt,
          updatedAt: message.createdAt
        }
      })
    )
    return { projects, conversations, messages, chatTurns: [] }
  }

  private mergeContent(
    current: WorkspaceContentRepositorySnapshot,
    incoming: CanonicalBackupContent,
    restoreCanonicalValues: boolean
  ): CanonicalBackupContent {
    const merge = <RecordType extends { readonly id: string }>(
      held: readonly RecordType[],
      restored: readonly RecordType[]
    ): RecordType[] => {
      const records = new Map(held.map((record) => [record.id, record]))
      for (const record of restored) {
        if (restoreCanonicalValues || !records.has(record.id)) records.set(record.id, record)
      }
      return [...records.values()]
    }
    const signatures = new Set(
      current.messages.map((message) =>
        JSON.stringify([
          message.conversationId,
          message.portable.role,
          message.portable.content,
          message.createdAt
        ])
      )
    )
    const nextPositions = new Map<string, number>()
    for (const message of current.messages) {
      nextPositions.set(
        message.conversationId,
        Math.max(nextPositions.get(message.conversationId) ?? 0, message.position + 1)
      )
    }
    const restoredMessages = incoming.messages.flatMap((message) => {
      if (!message.id.startsWith('backup-message-')) return [message]
      const signature = JSON.stringify([
        message.conversationId,
        message.portable.role,
        message.portable.content,
        message.createdAt
      ])
      if (signatures.has(signature)) return []
      signatures.add(signature)
      const position = nextPositions.get(message.conversationId) ?? message.position
      nextPositions.set(message.conversationId, position + 1)
      return [{ ...message, position }]
    })
    return {
      projects: merge(current.projects, incoming.projects),
      conversations: merge(current.conversations, incoming.conversations),
      messages: merge(current.messages, restoredMessages),
      chatTurns: merge(current.chatTurns, incoming.chatTurns)
    }
  }

  private restoreDocuments(
    data: DesktopBackupData,
    vectors: ReadonlyMap<string, string | null>
  ): number {
    let added = 0
    this.db.transaction(() => {
      for (const project of data.projects) {
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
            'INSERT INTO rag_chunks (doc_id, content, position, embedding) VALUES (?, ?, ?, ?)'
          )
          for (const chunk of document.chunks) {
            insertChunk.run(
              documentId,
              chunk.content,
              chunk.position,
              vectors.get(`${project.id}#${document.path}#${chunk.position}`) ?? null
            )
          }
          added += 1
        }
      }
    })()
    return added
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
