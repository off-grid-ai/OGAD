import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type Database from 'better-sqlite3-multiple-ciphers'
import { BundleError, WORKSPACE_SCHEMA_VERSION } from '@offgrid/sync/portable'
import type {
  AtomicImportContext,
  AttachmentRecord,
  ConversationRecord,
  DocumentRecord,
  FileRef,
  JsonValue,
  MediaKind,
  MessageRecord,
  ProjectRecord,
  WorkspaceDataPort,
  WorkspaceExport,
  WorkspaceSelection,
  WorkspaceSnapshot
} from '@offgrid/sync/portable'
import { FileTransaction } from './file-transaction'
import { ImportJournalStore } from './import-journal'

type Db = Database.Database
type JsonObject = { [key: string]: JsonValue }

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

interface ConversationRow {
  id: string
  title: string | null
  project_id: string | null
  created_at: string
  updated_at: string
}

interface MessageRow {
  portable_id: string
  conversation_id: string
  role: string
  content: string
  context: string | null
  created_at: string
}

interface DocumentRow {
  portable_id: string
  project_id: string
  name: string
  path: string
  size: number
  kind: string
  enabled: number
  created_at: string
  text_content: string | null
}

export interface PreparedPortableDocument {
  chunks: { content: string; position: number }[]
  embeddings: number[][]
}

export type PortableDocumentPreparer = (
  document: DocumentRecord,
  stagedPath: string
) => Promise<PreparedPortableDocument>

export interface DesktopImportSummary {
  projectsAdded: number
  projectsUpdated: number
  conversationsAdded: number
  conversationsUpdated: number
  messagesAdded: number
  messagesUpdated: number
  documentsAdded: number
  documentsUpdated: number
  attachmentsImported: number
  skipped: number
  warnings: string[]
}

function normalizeTimestamp(value: string): string {
  const candidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const instant = Date.parse(candidate)
  if (!Number.isFinite(instant))
    throw new BundleError(`Desktop data has invalid timestamp ${value}.`)
  return new Date(instant).toISOString()
}

function parseObject(value: string | null): JsonObject {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BundleError('Desktop message context is not a JSON object.')
    }
    return parsed as JsonObject
  } catch (error) {
    if (error instanceof BundleError) throw error
    throw new BundleError(`Desktop message context contains invalid JSON: ${String(error)}`)
  }
}

function mediaKind(value: unknown): MediaKind {
  if (value === 'text' || value === 'pdf' || value === 'docx' || value === 'image') return value
  if (value === 'audio' || value === 'video') return value
  return 'other'
}

function messageRole(value: string): MessageRecord['role'] {
  if (value === 'user' || value === 'assistant' || value === 'system' || value === 'tool')
    return value
  throw new BundleError(`Desktop message has unsupported role ${value}.`)
}

function fileExtension(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ''
}

function archiveKey(group: 'documents' | 'attachments', id: string, sourcePath: string): string {
  const digest = createHash('sha256').update(id).digest('hex')
  return `files/${group}/${digest}${fileExtension(sourcePath)}`
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function attachmentFromContext(
  raw: JsonObject,
  messageId: string,
  index: number
): { attachment: AttachmentRecord; file?: FileRef } {
  const localId = optionalString(raw.portableId) ?? optionalString(raw.id) ?? String(index)
  const id = optionalString(raw.portableId) ?? `${messageId}:attachment:${localId}`
  const sourcePath = optionalString(raw.path) ?? optionalString(raw.uri)
  const key = sourcePath ? archiveKey('attachments', id, sourcePath) : undefined
  return {
    attachment: {
      id,
      messageId,
      name: optionalString(raw.name) ?? optionalString(raw.fileName),
      kind: mediaKind(raw.kind ?? raw.type),
      mimeType: optionalString(raw.mimeType),
      size: optionalNumber(raw.size ?? raw.fileSize),
      width: optionalNumber(raw.width),
      height: optionalNumber(raw.height),
      durationSeconds: optionalNumber(raw.durationSeconds ?? raw.audioDurationSeconds),
      archiveKey: key,
      textContent: optionalString(raw.text ?? raw.textContent)
    },
    file: sourcePath && key ? { key, sourcePath } : undefined
  }
}

function messageMetadata(context: JsonObject): JsonObject | undefined {
  if (
    typeof context.portableMetadata === 'object' &&
    context.portableMetadata !== null &&
    !Array.isArray(context.portableMetadata)
  ) {
    return context.portableMetadata as JsonObject
  }
  const desktopContext = { ...context }
  delete desktopContext.attachments
  delete desktopContext.reasoning
  delete desktopContext.portableMetadata
  delete desktopContext.image
  return Object.keys(desktopContext).length > 0 ? { desktopContext } : undefined
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function ensurePortableSchema(db: Db): void {
  for (const table of ['rag_messages', 'rag_documents']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!columns.some(({ name }) => name === 'portable_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN portable_id TEXT`)
    }
    db.exec(
      `UPDATE ${table} SET portable_id = lower(hex(randomblob(16))) WHERE portable_id IS NULL`
    )
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_portable_id ON ${table}(portable_id)`)
  }
}

function existingIds(db: Db, table: string, column: string): Set<string> {
  return new Set(
    (db.prepare(`SELECT ${column} AS id FROM ${table}`).all() as { id: string }[]).map(
      ({ id }) => id
    )
  )
}

function remapIds(
  ids: readonly string[],
  existing: Set<string>,
  duplicate: boolean
): Map<string, string> {
  return new Map(ids.map((id) => [id, duplicate && existing.has(id) ? randomUUID() : id]))
}

function requireNoCollisions(
  snapshot: WorkspaceSnapshot,
  sets: ReturnType<typeof collisionSets>
): void {
  const collision =
    snapshot.projects.find(({ id }) => sets.projects.has(id))?.id ??
    snapshot.conversations.find(({ id }) => sets.conversations.has(id))?.id ??
    snapshot.messages.find(({ id }) => sets.messages.has(id))?.id ??
    snapshot.documents.find(({ id }) => sets.documents.has(id))?.id
  if (collision !== undefined) throw new BundleError(`Record ${collision} already exists.`)
}

function collisionSets(db: Db): {
  projects: Set<string>
  conversations: Set<string>
  messages: Set<string>
  documents: Set<string>
} {
  return {
    projects: existingIds(db, 'projects', 'id'),
    conversations: existingIds(db, 'rag_conversations', 'id'),
    messages: existingIds(db, 'rag_messages', 'portable_id'),
    documents: existingIds(db, 'rag_documents', 'portable_id')
  }
}

function increment(
  summary: DesktopImportSummary,
  entity: 'projects' | 'conversations' | 'messages' | 'documents',
  exists: boolean
): void {
  if (entity === 'projects') exists ? summary.projectsUpdated++ : summary.projectsAdded++
  else if (entity === 'conversations')
    exists ? summary.conversationsUpdated++ : summary.conversationsAdded++
  else if (entity === 'messages') exists ? summary.messagesUpdated++ : summary.messagesAdded++
  else exists ? summary.documentsUpdated++ : summary.documentsAdded++
}

function emptySummary(): DesktopImportSummary {
  return {
    projectsAdded: 0,
    projectsUpdated: 0,
    conversationsAdded: 0,
    conversationsUpdated: 0,
    messagesAdded: 0,
    messagesUpdated: 0,
    documentsAdded: 0,
    documentsUpdated: 0,
    attachmentsImported: 0,
    skipped: 0,
    warnings: []
  }
}

interface PrepareImportOptions {
  snapshot: WorkspaceSnapshot
  context: AtomicImportContext
  documentIds: Set<string>
  messageIds: Set<string>
  attachmentsByMessage: ReadonlyMap<string, AttachmentRecord[]>
  shouldWrite: (exists: boolean) => boolean
  prepareDocument: PortableDocumentPreparer
  journals: ImportJournalStore
}

async function prepareImportFiles(options: PrepareImportOptions): Promise<{
  fileTransaction: FileTransaction
  filePaths: ReadonlyMap<string, string>
  documentFileKeys: ReadonlyMap<string, string>
  preparedDocuments: ReadonlyMap<string, PreparedPortableDocument>
}> {
  const { snapshot, context, shouldWrite, journals } = options
  const requiredKeys = new Set<string>()
  const documentFileKeys = new Map<string, string>()
  const importFiles = [...context.files]
  const generatedStagePaths: string[] = []
  for (const document of snapshot.documents) {
    if (
      shouldWrite(options.documentIds.has(document.id)) &&
      !document.archiveKey &&
      !document.textContent?.trim()
    ) {
      throw new BundleError(
        `Document ${document.id} must contain a file or non-empty extracted text.`
      )
    }
  }
  for (const document of snapshot.documents) {
    if (!shouldWrite(options.documentIds.has(document.id))) continue
    const staged = document.archiveKey
      ? undefined
      : journals.stageText(document.id, document.textContent!)
    const key = document.archiveKey ?? staged!.key
    if (staged) {
      importFiles.push(staged)
      generatedStagePaths.push(staged.stagedPath)
    }
    requiredKeys.add(key)
    documentFileKeys.set(document.id, key)
  }
  for (const message of snapshot.messages) {
    if (!shouldWrite(options.messageIds.has(message.id))) continue
    for (const attachment of options.attachmentsByMessage.get(message.id) ?? []) {
      if (attachment.archiveKey) requiredKeys.add(attachment.archiveKey)
    }
  }
  const stagedByKey = new Map(importFiles.map((file) => [file.key, file.stagedPath]))
  const preparedDocuments = new Map<string, PreparedPortableDocument>()
  try {
    for (const document of snapshot.documents) {
      if (!shouldWrite(options.documentIds.has(document.id))) continue
      const fileKey = documentFileKeys.get(document.id)
      const stagedPath = fileKey ? stagedByKey.get(fileKey) : undefined
      if (!stagedPath) throw new BundleError(`Document ${document.id} has no staged file.`)
      const prepared = await options.prepareDocument(document, stagedPath)
      if (
        prepared.chunks.length === 0 ||
        prepared.embeddings.length !== prepared.chunks.length ||
        prepared.embeddings.some((embedding) => embedding.length === 0)
      ) {
        throw new BundleError(`Document ${document.name} could not be made searchable.`)
      }
      preparedDocuments.set(document.id, prepared)
    }
    const fileTransaction = await FileTransaction.create(
      importFiles.filter(({ key }) => requiredKeys.has(key)),
      context.collisionPolicy,
      journals
    )
    return {
      fileTransaction,
      filePaths: fileTransaction.paths(),
      documentFileKeys,
      preparedDocuments
    }
  } catch (error) {
    journals.discardStages(generatedStagePaths)
    throw error
  }
}

export class DesktopWorkspaceDataPort implements WorkspaceDataPort<DesktopImportSummary> {
  constructor(
    private readonly db: Db,
    private readonly prepareDocument: PortableDocumentPreparer,
    private readonly journals: ImportJournalStore
  ) {}

  summary(): {
    projects: number
    conversations: number
    messages: number
    documents: number
    attachments: number
  } {
    ensurePortableSchema(this.db)
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
    const contexts = this.db.prepare('SELECT context FROM rag_messages').all() as {
      context: string | null
    }[]
    const attachments = contexts.reduce((total, { context }) => {
      const value = parseObject(context).attachments
      return total + (Array.isArray(value) ? value.length : 0)
    }, 0)
    return {
      projects: count('projects'),
      conversations: count('rag_conversations'),
      messages: contexts.length,
      documents: count('rag_documents'),
      attachments
    }
  }

  async collect(selection: WorkspaceSelection): Promise<WorkspaceExport | null> {
    ensurePortableSchema(this.db)
    this.journals.ensureSchema()
    const conversationFilter = selection.kind === 'conversation' ? [selection.id] : []
    let conversations: ConversationRow[]
    if (selection.kind === 'project') {
      conversations = this.db
        .prepare('SELECT * FROM rag_conversations WHERE project_id = ?')
        .all(selection.id) as ConversationRow[]
    } else if (selection.kind === 'conversation') {
      conversations = this.db
        .prepare('SELECT * FROM rag_conversations WHERE id = ?')
        .all(selection.id) as ConversationRow[]
      if (conversations.length === 0) return null
    } else
      conversations = this.db.prepare('SELECT * FROM rag_conversations').all() as ConversationRow[]

    let projectIds: string[]
    if (selection.kind === 'project') projectIds = [selection.id]
    else if (selection.kind === 'conversation')
      projectIds = conversations[0]?.project_id ? [conversations[0].project_id] : []
    else
      projectIds = (this.db.prepare('SELECT id FROM projects').all() as { id: string }[]).map(
        ({ id }) => id
      )

    const projectRows =
      projectIds.length === 0
        ? []
        : (this.db
            .prepare(`SELECT * FROM projects WHERE id IN (${placeholders(projectIds)})`)
            .all(...projectIds) as ProjectRow[])
    if (selection.kind === 'project' && projectRows.length === 0) return null

    const conversationIds =
      conversationFilter.length > 0 ? conversationFilter : conversations.map(({ id }) => id)
    const messages =
      conversationIds.length === 0
        ? []
        : (this.db
            .prepare(
              `SELECT * FROM rag_messages WHERE conversation_id IN (${placeholders(conversationIds)}) ORDER BY id`
            )
            .all(...conversationIds) as MessageRow[])
    const documentRows =
      selection.kind === 'conversation' || projectIds.length === 0
        ? []
        : (this.db
            .prepare(
              `SELECT d.*, (SELECT group_concat(content, char(10)) FROM rag_chunks WHERE doc_id = d.id ORDER BY position) AS text_content
               FROM rag_documents d WHERE project_id IN (${placeholders(projectIds)})`
            )
            .all(...projectIds) as DocumentRow[])

    const files: FileRef[] = []
    const attachments: AttachmentRecord[] = []
    const canonicalMessages: MessageRecord[] = messages.map((row) => {
      const context = parseObject(row.context)
      const rawAttachments = Array.isArray(context.attachments) ? context.attachments : []
      for (const [index, raw] of rawAttachments.entries()) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
        const mapped = attachmentFromContext(raw as JsonObject, row.portable_id, index)
        attachments.push(mapped.attachment)
        if (mapped.file) {
          if (!fs.existsSync(mapped.file.sourcePath))
            throw new BundleError(`Attachment file is missing: ${mapped.file.sourcePath}.`)
          files.push(mapped.file)
        }
      }
      return {
        id: row.portable_id,
        conversationId: row.conversation_id,
        role: messageRole(row.role),
        content: row.content,
        reasoningContent: optionalString(context.reasoning),
        createdAt: normalizeTimestamp(row.created_at),
        metadata: messageMetadata(context)
      }
    })

    const documents: DocumentRecord[] = documentRows.map((row) => {
      if (!fs.existsSync(row.path)) throw new BundleError(`Knowledge file is missing: ${row.path}.`)
      const stats = fs.statSync(row.path)
      const key = archiveKey('documents', row.portable_id, row.path)
      files.push({ key, sourcePath: row.path })
      return {
        id: row.portable_id,
        projectId: row.project_id,
        name: row.name,
        kind: mediaKind(row.kind),
        size: stats.size,
        createdAt: normalizeTimestamp(row.created_at),
        enabled: row.enabled === 1,
        archiveKey: key,
        textContent: row.text_content ?? undefined
      }
    })

    return {
      snapshot: {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        selection,
        workspaces: [],
        projects: projectRows.map(
          (row): ProjectRecord => ({
            id: row.id,
            name: row.name,
            description: row.description,
            systemPrompt: row.system_prompt,
            icon: row.icon ?? undefined,
            includeMemory: row.include_memory === 1,
            createdAt: normalizeTimestamp(row.created_at),
            updatedAt: normalizeTimestamp(row.updated_at)
          })
        ),
        conversations: conversations.map(
          (row): ConversationRecord => ({
            id: row.id,
            projectId: row.project_id ?? undefined,
            title: row.title ?? undefined,
            createdAt: normalizeTimestamp(row.created_at),
            updatedAt: normalizeTimestamp(row.updated_at)
          })
        ),
        messages: canonicalMessages,
        documents,
        attachments
      },
      files
    }
  }

  async applyAtomically(
    snapshot: WorkspaceSnapshot,
    context: AtomicImportContext
  ): Promise<DesktopImportSummary> {
    ensurePortableSchema(this.db)
    this.journals.ensureSchema()
    const sets = collisionSets(this.db)
    if (context.collisionPolicy === 'reject') requireNoCollisions(snapshot, sets)
    const duplicate = context.collisionPolicy === 'duplicate'
    const projectIds = remapIds(
      snapshot.projects.map(({ id }) => id),
      sets.projects,
      duplicate
    )
    const conversationIds = remapIds(
      snapshot.conversations.map(({ id }) => id),
      sets.conversations,
      duplicate
    )
    const messageIds = remapIds(
      snapshot.messages.map(({ id }) => id),
      sets.messages,
      duplicate
    )
    const documentIds = remapIds(
      snapshot.documents.map(({ id }) => id),
      sets.documents,
      duplicate
    )
    const shouldWrite = (exists: boolean): boolean =>
      context.collisionPolicy !== 'keep-existing' || !exists

    const attachmentsByMessage = new Map<string, AttachmentRecord[]>()
    for (const attachment of snapshot.attachments) {
      const list = attachmentsByMessage.get(attachment.messageId) ?? []
      list.push(attachment)
      attachmentsByMessage.set(attachment.messageId, list)
    }
    const { fileTransaction, filePaths, documentFileKeys, preparedDocuments } =
      await prepareImportFiles({
        snapshot,
        context,
        documentIds: sets.documents,
        messageIds: sets.messages,
        attachmentsByMessage,
        shouldWrite,
        prepareDocument: this.prepareDocument,
        journals: this.journals
      })
    const summary = emptySummary()

    const write = this.db.transaction(() => {
      fileTransaction.apply()
      for (const project of snapshot.projects) {
        const exists = sets.projects.has(project.id)
        if (!shouldWrite(exists)) {
          summary.skipped++
          continue
        }
        this.db
          .prepare(
            `INSERT INTO projects (id, name, description, system_prompt, icon, include_memory, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
               system_prompt=excluded.system_prompt, icon=excluded.icon, include_memory=excluded.include_memory,
               created_at=excluded.created_at, updated_at=excluded.updated_at`
          )
          .run(
            projectIds.get(project.id)!,
            project.name,
            project.description,
            project.systemPrompt,
            project.icon ?? null,
            project.includeMemory === false ? 0 : 1,
            project.createdAt,
            project.updatedAt
          )
        increment(summary, 'projects', exists && !duplicate)
      }
      for (const conversation of snapshot.conversations) {
        const exists = sets.conversations.has(conversation.id)
        if (!shouldWrite(exists)) {
          summary.skipped++
          continue
        }
        this.db
          .prepare(
            `INSERT INTO rag_conversations (id, title, project_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, project_id=excluded.project_id,
               created_at=excluded.created_at, updated_at=excluded.updated_at`
          )
          .run(
            conversationIds.get(conversation.id)!,
            conversation.title ?? null,
            conversation.projectId ? projectIds.get(conversation.projectId)! : null,
            conversation.createdAt,
            conversation.updatedAt
          )
        increment(summary, 'conversations', exists && !duplicate)
      }
      for (const message of snapshot.messages) {
        const exists = sets.messages.has(message.id)
        if (!shouldWrite(exists)) {
          summary.skipped++
          continue
        }
        const desktopContext =
          message.metadata &&
          typeof message.metadata.desktopContext === 'object' &&
          message.metadata.desktopContext !== null
            ? (message.metadata.desktopContext as JsonObject)
            : {}
        const restoredAttachments = (attachmentsByMessage.get(message.id) ?? []).map(
          (attachment) => ({
            id: attachment.id,
            portableId: attachment.id,
            name: attachment.name,
            kind: attachment.kind,
            mimeType: attachment.mimeType,
            size: attachment.size,
            width: attachment.width,
            height: attachment.height,
            durationSeconds: attachment.durationSeconds,
            text: attachment.textContent,
            path: attachment.archiveKey ? filePaths.get(attachment.archiveKey) : undefined,
            status: 'ready'
          })
        )
        summary.attachmentsImported += restoredAttachments.length
        const restoredContext = {
          ...desktopContext,
          portableMetadata: message.metadata,
          reasoning: message.reasoningContent,
          attachments: restoredAttachments
        }
        this.db
          .prepare(
            `INSERT INTO rag_messages (portable_id, conversation_id, role, content, context, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(portable_id) DO UPDATE SET conversation_id=excluded.conversation_id,
               role=excluded.role, content=excluded.content, context=excluded.context, created_at=excluded.created_at`
          )
          .run(
            messageIds.get(message.id)!,
            conversationIds.get(message.conversationId)!,
            message.role,
            message.content,
            JSON.stringify(restoredContext),
            message.createdAt
          )
        increment(summary, 'messages', exists && !duplicate)
      }
      for (const document of snapshot.documents) {
        const exists = sets.documents.has(document.id)
        if (!shouldWrite(exists)) {
          summary.skipped++
          continue
        }
        const fileKey = documentFileKeys.get(document.id)
        const documentPath = fileKey ? filePaths.get(fileKey) : undefined
        if (!documentPath) throw new BundleError(`Document ${document.id} has no restored file.`)
        this.db
          .prepare(
            `INSERT INTO rag_documents (portable_id, project_id, name, path, size, kind, enabled, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(portable_id) DO UPDATE SET project_id=excluded.project_id, name=excluded.name,
               path=excluded.path, size=excluded.size, kind=excluded.kind, enabled=excluded.enabled,
               created_at=excluded.created_at`
          )
          .run(
            documentIds.get(document.id)!,
            projectIds.get(document.projectId)!,
            document.name,
            documentPath,
            document.size,
            document.kind,
            document.enabled ? 1 : 0,
            document.createdAt
          )
        const row = this.db
          .prepare('SELECT id FROM rag_documents WHERE portable_id = ?')
          .get(documentIds.get(document.id)!) as { id: number } | undefined
        const prepared = preparedDocuments.get(document.id)
        if (!row || !prepared) throw new BundleError(`Document ${document.id} was not prepared.`)
        this.db.prepare('DELETE FROM rag_chunks WHERE doc_id = ?').run(row.id)
        const insertChunk = this.db.prepare(
          'INSERT INTO rag_chunks (doc_id, content, position, embedding) VALUES (?, ?, ?, ?)'
        )
        prepared.chunks.forEach((chunk, index) =>
          insertChunk.run(
            row.id,
            chunk.content,
            chunk.position,
            JSON.stringify(prepared.embeddings[index])
          )
        )
        increment(summary, 'documents', exists && !duplicate)
      }
      fileTransaction.markCommitted()
    })

    try {
      write()
    } catch (error) {
      fileTransaction.rollback(error)
    }
    summary.warnings.push(...fileTransaction.finish())
    return summary
  }
}
