import type { ChatTurnRecord } from '@offgrid/application'
import { CHAT_TURN_STATUSES } from '@offgrid/models'
import { parseSyncedMessageContext } from '@offgrid/sync'
import type Database from 'better-sqlite3-multiple-ciphers'
import { WORKSPACE_CONTENT_SCHEMA_VERSION } from './schema'

type Project = {
  id: string
  name: string
  description: string | null
  system_prompt: string | null
  icon: string | null
  include_memory: number | null
  created_at: string | null
  updated_at: string | null
}
type Conversation = {
  id: string
  title: string | null
  project_id: string | null
  created_at: string | null
  updated_at: string | null
}
type Message = {
  id: number
  uuid: string | null
  conversation_id: string
  role: string
  content: string
  context: string | null
  origin_device_id: string | null
  origin_device_name: string | null
  created_at: string | null
}
type TurnRow = { conversation_id: string; turns_json: string; updated_at: string | null }
type LegacyTurn = Partial<ChatTurnRecord> & { id?: unknown; status?: unknown; request?: unknown }
type PreparedMessage = Message & {
  stableId: string
  position: number
  turnId: string | null
  portable: object | null
  local: object | null
}
type PreparedTurnRow = { conversationId: string; turns: ChatTurnRecord[]; updatedAt: string }
type Counts = {
  projects: number
  conversations: number
  messages: number
  localStates: number
  turnRows: number
  turns: number
}

export interface LegacyWorkspaceContentCopyResult {
  readonly phase: 'completed' | 'already_completed'
  readonly projectsCopied: number
  readonly conversationsCopied: number
  readonly messagesCopied: number
  readonly chatTurnRowsCopied: number
  readonly chatTurnsCopied: number
}

export type WorkspaceContentTargetJournalStatus = 'not_started' | 'started' | 'completed' | 'failed'

/** Restart-safe, non-destructive copy from the legacy Desktop chat tables. */
export class DesktopWorkspaceContentMigrationCoordinator {
  constructor(private readonly db: Database.Database) {}

  readTargetJournalStatus(): WorkspaceContentTargetJournalStatus {
    return this.journalStatus() ?? 'not_started'
  }

  copyLegacyWorkspaceContent(): LegacyWorkspaceContentCopyResult {
    if (this.journalStatus() === 'completed') return this.result('already_completed')
    const startedAt = new Date().toISOString()
    try {
      return this.db
        .transaction(() => {
          this.markStarted(startedAt)
          const projects = this.read<Project>('projects', 'id')
          const conversations = this.read<Conversation>('rag_conversations', 'id')
          const projectIds = new Set(projects.map((row) => row.id))
          const conversationIds = new Set(conversations.map((row) => row.id))
          const messages = prepareMessages(
            this.read<Message>('rag_messages', 'conversation_id, created_at, id'),
            conversationIds
          )
          const preparedTurns = prepareTurns(
            this.read<TurnRow>('chat_session_turns', 'conversation_id'),
            {
              messages,
              conversationIds,
              projectIds
            }
          )
          this.putProjects(projects, startedAt)
          this.putConversations(conversations, projectIds, startedAt)
          this.putMessages(messages, startedAt)
          this.putTurns(preparedTurns.rows)
          this.verify({
            projects: projects.length,
            conversations: conversations.length,
            messages: messages.length,
            localStates: messages.filter((row) => row.local).length,
            turnRows: preparedTurns.rows.length,
            turns: preparedTurns.count
          })
          const journalUpdate = this.db
            .prepare(
              "UPDATE workspace_content_migration_journal SET status='completed', finished_at=?, failure_message=NULL WHERE target_version=? AND status='started'"
            )
            .run(new Date().toISOString(), WORKSPACE_CONTENT_SCHEMA_VERSION)
          if (journalUpdate.changes !== 1) {
            throw new Error('Workspace content migration journal did not complete')
          }
          return {
            phase: 'completed' as const,
            projectsCopied: projects.length,
            conversationsCopied: conversations.length,
            messagesCopied: messages.length,
            chatTurnRowsCopied: preparedTurns.rows.length,
            chatTurnsCopied: preparedTurns.count
          }
        })
        .immediate()
    } catch (cause) {
      this.markFailed(startedAt, failureMessage(cause))
      throw cause
    }
  }

  private putProjects(rows: readonly Project[], fallback: string): void {
    const put = this.db.prepare(
      `INSERT INTO workspace_content_projects (id,name,description,system_prompt,icon,include_memory,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,system_prompt=excluded.system_prompt,icon=excluded.icon,include_memory=excluded.include_memory,created_at=excluded.created_at,updated_at=excluded.updated_at`
    )
    for (const row of rows)
      put.run(
        required(row.id, 'projects.id'),
        required(row.name, 'projects.name'),
        row.description ?? '',
        row.system_prompt ?? '',
        row.icon,
        row.include_memory === 0 ? 0 : 1,
        time(row.created_at, fallback),
        time(row.updated_at, fallback)
      )
  }

  private putConversations(
    rows: readonly Conversation[],
    projectIds: ReadonlySet<string>,
    fallback: string
  ): void {
    const put = this.db.prepare(
      `INSERT INTO workspace_content_conversations (id,title,model_id,project_id,compaction_summary,compaction_cutoff_message_id,created_at,updated_at) VALUES (?,?,NULL,?,NULL,NULL,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,project_id=excluded.project_id,created_at=excluded.created_at,updated_at=excluded.updated_at`
    )
    for (const row of rows) {
      const projectId = optional(row.project_id)
      put.run(
        required(row.id, 'rag_conversations.id'),
        row.title ?? '',
        projectId && projectIds.has(projectId) ? projectId : null,
        time(row.created_at, fallback),
        time(row.updated_at, fallback)
      )
    }
  }

  private putMessages(rows: readonly PreparedMessage[], fallback: string): void {
    const put = this.db.prepare(
      `INSERT INTO workspace_content_messages (id,conversation_id,turn_id,position,role,content,content_json,context_json,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?,?) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id,turn_id=excluded.turn_id,position=excluded.position,role=excluded.role,content=excluded.content,content_json=NULL,context_json=excluded.context_json,created_at=excluded.created_at,updated_at=excluded.updated_at`
    )
    const putLocal = this.db.prepare(
      `INSERT INTO workspace_content_local_message_state (message_id,state_json) VALUES (?,?) ON CONFLICT(message_id) DO UPDATE SET state_json=excluded.state_json`
    )
    const removeLocal = this.db.prepare(
      'DELETE FROM workspace_content_local_message_state WHERE message_id=?'
    )
    for (const row of rows) {
      const createdAt = time(row.created_at, fallback)
      put.run(
        row.stableId,
        row.conversation_id,
        row.turnId,
        row.position,
        required(row.role, `rag_messages.${row.id}.role`),
        row.content,
        row.portable ? JSON.stringify(row.portable) : null,
        createdAt,
        createdAt
      )
      row.local
        ? putLocal.run(row.stableId, JSON.stringify(row.local))
        : removeLocal.run(row.stableId)
    }
  }

  private putTurns(rows: readonly PreparedTurnRow[]): void {
    const put = this.db.prepare(
      `INSERT INTO workspace_content_chat_turns (conversation_id,turns_json,updated_at) VALUES (?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET turns_json=excluded.turns_json,updated_at=excluded.updated_at`
    )
    for (const row of rows) put.run(row.conversationId, JSON.stringify(row.turns), row.updatedAt)
  }

  private journalStatus(): Exclude<WorkspaceContentTargetJournalStatus, 'not_started'> | undefined {
    return this.db
      .prepare('SELECT status FROM workspace_content_migration_journal WHERE target_version=?')
      .pluck()
      .get(WORKSPACE_CONTENT_SCHEMA_VERSION) as 'started' | 'completed' | 'failed' | undefined
  }
  private markStarted(at: string): void {
    this.db
      .prepare(
        `INSERT INTO workspace_content_migration_journal (target_version,status,started_at,finished_at,failure_message) VALUES (?,'started',?,NULL,NULL) ON CONFLICT(target_version) DO UPDATE SET status='started',started_at=excluded.started_at,finished_at=NULL,failure_message=NULL`
      )
      .run(WORKSPACE_CONTENT_SCHEMA_VERSION, at)
  }
  private markFailed(at: string, message: string): void {
    this.db
      .prepare(
        `INSERT INTO workspace_content_migration_journal (target_version,status,started_at,finished_at,failure_message) VALUES (?,'failed',?,?,?) ON CONFLICT(target_version) DO UPDATE SET status='failed',started_at=excluded.started_at,finished_at=excluded.finished_at,failure_message=excluded.failure_message`
      )
      .run(WORKSPACE_CONTENT_SCHEMA_VERSION, at, new Date().toISOString(), message)
  }
  private read<T>(table: string, order: string): T[] {
    if (!this.tableExists(table)) return []
    return this.db.prepare(`SELECT * FROM ${table} ORDER BY ${order} ASC`).all() as T[]
  }
  private tableExists(table: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !==
      undefined
    )
  }
  private sourceCount(input: {
    target: string
    source: string
    sourceId: string
    targetId?: string
  }): number {
    const { target, source, sourceId, targetId = sourceId } = input
    if (!this.tableExists(source)) return 0
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) count FROM ${target} target WHERE EXISTS (SELECT 1 FROM ${source} source WHERE source.${sourceId}=target.${targetId})`
        )
        .get() as { count: number }
    ).count
  }
  private count(table: string): number {
    return (this.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count
  }

  private verify(expected: Counts): void {
    const actual: Counts = {
      projects: this.sourceCount({
        target: 'workspace_content_projects',
        source: 'projects',
        sourceId: 'id'
      }),
      conversations: this.sourceCount({
        target: 'workspace_content_conversations',
        source: 'rag_conversations',
        sourceId: 'id'
      }),
      messages: this.sourceCount({
        target: 'workspace_content_messages',
        source: 'rag_messages',
        sourceId: 'uuid',
        targetId: 'id'
      }),
      localStates: (
        this.db
          .prepare(
            `SELECT COUNT(*) count FROM workspace_content_local_message_state local JOIN workspace_content_messages message ON message.id=local.message_id WHERE EXISTS (SELECT 1 FROM rag_messages source WHERE source.uuid=message.id)`
          )
          .get() as { count: number }
      ).count,
      turnRows: this.sourceCount({
        target: 'workspace_content_chat_turns',
        source: 'chat_session_turns',
        sourceId: 'conversation_id'
      }),
      turns: (
        this.db
          .prepare(
            `SELECT COALESCE(SUM(json_array_length(target.turns_json)),0) count FROM workspace_content_chat_turns target WHERE EXISTS (SELECT 1 FROM chat_session_turns source WHERE source.conversation_id=target.conversation_id)`
          )
          .get() as { count: number }
      ).count
    }
    for (const key of Object.keys(expected) as (keyof Counts)[])
      if (actual[key] !== expected[key])
        throw new Error(
          `Workspace content copy verification failed: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
        )
  }

  private result(phase: 'already_completed'): LegacyWorkspaceContentCopyResult {
    return {
      phase,
      projectsCopied: this.count('workspace_content_projects'),
      conversationsCopied: this.count('workspace_content_conversations'),
      messagesCopied: this.count('workspace_content_messages'),
      chatTurnRowsCopied: this.count('workspace_content_chat_turns'),
      chatTurnsCopied: (
        this.db
          .prepare(
            'SELECT COALESCE(SUM(json_array_length(turns_json)),0) count FROM workspace_content_chat_turns'
          )
          .get() as { count: number }
      ).count
    }
  }
}

function prepareMessages(
  rows: readonly Message[],
  conversations: ReadonlySet<string>
): PreparedMessage[] {
  const positions = new Map<string, number>()
  return rows.map((row) => {
    const conversationId = required(row.conversation_id, `rag_messages.${row.id}.conversation_id`)
    if (!conversations.has(conversationId))
      throw new Error(`rag_messages.${row.id} has no legacy conversation`)
    const decoded = decodeContext(row.context)
    const portable = parseSyncedMessageContext(decoded)
    const local: Record<string, unknown> = { ...decoded }
    for (const key of Object.keys(portable ?? {})) delete local[key]
    if (row.origin_device_id) local.origin_device_id = row.origin_device_id
    if (row.origin_device_name) local.origin_device_name = row.origin_device_name
    const session =
      decoded.chatSession && typeof decoded.chatSession === 'object'
        ? (decoded.chatSession as Record<string, unknown>)
        : undefined
    const position = positions.get(conversationId) ?? 0
    positions.set(conversationId, position + 1)
    return {
      ...row,
      stableId: required(row.uuid, `rag_messages.${row.id}.uuid`),
      position,
      turnId: optional(decoded.chatTurnId) ?? optional(session?.turnId),
      portable,
      local: Object.keys(local).length ? local : null
    }
  })
}

type TurnPreparation = {
  messages: readonly PreparedMessage[]
  conversationIds: ReadonlySet<string>
  projectIds: ReadonlySet<string>
}

function prepareTurns(
  rows: readonly TurnRow[],
  input: TurnPreparation
): { rows: PreparedTurnRow[]; count: number } {
  const { messages, conversationIds, projectIds } = input
  const linked = new Map<string, PreparedMessage[]>()
  for (const message of messages)
    if (message.turnId) {
      const key = `${message.conversation_id}\0${message.turnId}`
      linked.set(key, [...(linked.get(key) ?? []), message])
    }
  let count = 0
  const prepared = rows.map((row) => {
    const conversationId = required(row.conversation_id, 'chat_session_turns.conversation_id')
    if (!conversationIds.has(conversationId))
      throw new Error(`chat_session_turns.${conversationId} has no legacy conversation`)
    const value: unknown = JSON.parse(row.turns_json)
    if (!Array.isArray(value))
      throw new Error(`chat_session_turns.${conversationId} is not an array`)
    const updatedAt = time(row.updated_at, new Date(0).toISOString())
    const turns = value.map((item, index) =>
      prepareTurn({ item, index, conversationId, updatedAt, linked, messages, projectIds })
    )
    count += turns.length
    return { conversationId, turns, updatedAt }
  })
  return { rows: prepared, count }
}

function decodeContext(context: string | null): Record<string, unknown> {
  if (!context) return {}
  try {
    const decoded: unknown = JSON.parse(context)
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : { legacyContext: decoded }
  } catch {
    return { legacyContext: context }
  }
}

type TurnInput = Pick<TurnPreparation, 'messages' | 'projectIds'> & {
  item: unknown
  index: number
  conversationId: string
  updatedAt: string
  linked: ReadonlyMap<string, PreparedMessage[]>
}

function prepareTurn(input: TurnInput): ChatTurnRecord {
  const { item, index, conversationId, updatedAt, linked, messages, projectIds } = input
  if (!item || typeof item !== 'object' || Array.isArray(item))
    throw new Error(`chat_session_turns.${conversationId}[${index}] is not an object`)
  const turn = item as LegacyTurn
  const id = required(turn.id, `chat_session_turns.${conversationId}[${index}].id`)
  const matches = linked.get(`${conversationId}\0${id}`) ?? []
  const userMessageId =
    existingMessageId(turn.userMessageId, messages, conversationId) ??
    matches.find((message) => message.role === 'user')?.stableId
  if (!userMessageId) throw new Error(`chat turn ${id} has no durable user message`)
  const responseMessageIds = responseIds({ turn, matches, messages, conversationId, userMessageId })
  linkMessagesToTurn({
    messages,
    conversationId,
    turnId: id,
    messageIds: [userMessageId, ...responseMessageIds]
  })
  const projectId = optional(turn.projectId)
  return {
    id,
    conversationId,
    ...(projectId && projectIds.has(projectId) ? { projectId } : {}),
    userMessageId,
    responseMessageIds,
    status: turnStatus(turn, id),
    request: turnRequest(turn, id),
    requestId: optional(turn.requestId) ?? id,
    position: nonNegativeInteger(turn.position, index),
    recoveryAttempts: nonNegativeInteger(turn.recoveryAttempts, 0),
    lastError: optional(turn.lastError),
    createdAt: turnCreatedAt(turn.createdAt, updatedAt, index),
    updatedAt: optional(turn.updatedAt) ?? updatedAt
  }
}

function existingMessageId(
  value: unknown,
  messages: readonly PreparedMessage[],
  conversationId: string
): string | null {
  const id = optional(value)
  return id && hasMessage(messages, conversationId, id) ? id : null
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function turnCreatedAt(value: unknown, updatedAt: string, index: number): string {
  const explicit = optional(value)
  if (explicit) return explicit
  const base = Date.parse(updatedAt)
  return Number.isFinite(base)
    ? new Date(base + index).toISOString()
    : `${updatedAt}:${String(index).padStart(8, '0')}`
}

function linkMessagesToTurn(input: {
  messages: readonly PreparedMessage[]
  conversationId: string
  turnId: string
  messageIds: readonly string[]
}): void {
  const { messages, conversationId, turnId, messageIds } = input
  const ids = new Set(messageIds)
  for (const message of messages) {
    if (message.conversation_id === conversationId && ids.has(message.stableId)) {
      message.turnId = turnId
    }
  }
}

function responseIds(input: {
  turn: LegacyTurn
  matches: readonly PreparedMessage[]
  messages: readonly PreparedMessage[]
  conversationId: string
  userMessageId: string
}): string[] {
  const { turn, matches, messages, conversationId, userMessageId } = input
  if (Array.isArray(turn.responseMessageIds)) {
    const explicit = turn.responseMessageIds.filter(
      (candidate): candidate is string =>
        typeof candidate === 'string' && hasMessage(messages, conversationId, candidate)
    )
    if (explicit.length === turn.responseMessageIds.length) return explicit
  }
  return matches
    .filter((message) => message.stableId !== userMessageId)
    .map((message) => message.stableId)
}

function turnStatus(turn: LegacyTurn, id: string): ChatTurnRecord['status'] {
  const status = required(turn.status, `chat turn ${id}.status`)
  if (!CHAT_TURN_STATUSES.includes(status as ChatTurnRecord['status']))
    throw new Error(`chat turn ${id} has an invalid status`)
  return status as ChatTurnRecord['status']
}

function turnRequest(turn: LegacyTurn, id: string): ChatTurnRecord['request'] {
  if (!turn.request || typeof turn.request !== 'object')
    throw new Error(`chat turn ${id} has no request`)
  return turn.request as ChatTurnRecord['request']
}

const hasMessage = (
  messages: readonly PreparedMessage[],
  conversationId: string,
  id: string
): boolean =>
  messages.some((message) => message.stableId === id && message.conversation_id === conversationId)

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is empty`)
  return value
}
const optional = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null
const time = (value: string | null, fallback: string): string => optional(value) ?? fallback
function failureMessage(cause: unknown): string {
  const value = cause instanceof Error ? cause.message : String(cause)
  return value.trim() || 'Workspace content migration failed.'
}
