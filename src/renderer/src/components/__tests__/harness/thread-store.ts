// How main stores and reads a chat's versions (database.ts), for the fakes of main that renderer
// tests use. The thread rules themselves are the real shared ones (chat-thread.ts in @offgrid/sync).
import { appendPlace, chatThread, neighbourVersion, parentOfVersion } from '@offgrid/sync'

export interface ThreadStoredRow {
  id: string | number
  uuid?: string
  role: string
  content: string
  context?: unknown
}

type Context = Record<string, unknown>

const contextOf = (row: ThreadStoredRow): Context =>
  (typeof row.context === 'string' ? JSON.parse(row.context) : (row.context ?? {})) as Context

const uuidOf = (row: ThreadStoredRow): string => String(row.uuid ?? row.id)

function threadRows<T extends ThreadStoredRow>(
  rows: readonly T[]
): Array<{ row: T; uuid: string; parent?: string; selectedAt?: number }> {
  return rows.map((row) => {
    const context = contextOf(row)
    return {
      row,
      uuid: uuidOf(row),
      ...(typeof context.parent === 'string' ? { parent: context.parent } : {}),
      ...(typeof context.selectedAt === 'number' ? { selectedAt: context.selectedAt } : {})
    }
  })
}

/** Lists of versions kept inside one message are not stored (versions are messages). */
function withoutLists(context: unknown): Context {
  const {
    variants: _variants,
    variantIndex: _variantIndex,
    branches: _branches,
    ...rest
  } = (context && typeof context === 'object' ? context : {}) as Context
  return rest
}

let clock = 1
/** A later choice always wins, even within one millisecond of test time. */
const nextChoice = (): number => Date.now() + clock++

export class ThreadStore {
  private readonly pending = new Map<string, string>()

  /** The context a new message is stored with: a version takes its parent and a choice time;
   *  an appended message stores its parent only once the chat has versions. */
  place(
    rows: readonly ThreadStoredRow[],
    conversationId: string,
    role: string,
    context: unknown
  ): Context | undefined {
    const base = withoutLists(context)
    const parent = role === 'assistant' ? this.pending.get(conversationId) : undefined
    this.pending.delete(conversationId)
    if (typeof base.parent === 'string' || parent) {
      if (typeof base.parent !== 'string') base.parent = parent
      if (typeof base.selectedAt !== 'number') base.selectedAt = nextChoice()
      return base
    }
    const place = appendPlace(threadRows(rows))
    if (place.parent) return { ...base, parent: place.parent }
    return context && typeof context === 'object' ? base : undefined
  }

  /** An update keeps the message's place in its thread. */
  update(row: ThreadStoredRow, context: unknown): Context {
    const held = contextOf(row)
    return {
      ...(typeof held.parent === 'string' ? { parent: held.parent } : {}),
      ...(typeof held.selectedAt === 'number' ? { selectedAt: held.selectedAt } : {}),
      ...withoutLists(context)
    }
  }

  /** The shown thread, as getRagMessages returns it. */
  read<T extends ThreadStoredRow>(
    rows: readonly T[]
  ): Array<T & { versions?: { index: number; count: number } }> {
    const thread = chatThread(threadRows(rows))
    return thread.messages.map(({ row, uuid }) => {
      const versions = thread.versions.get(uuid)
      return versions ? { ...row, versions: { index: versions.index, count: versions.count } } : row
    })
  }

  prepareAnswerVersion(
    rows: readonly ThreadStoredRow[],
    conversationId: string,
    ofUuid: string
  ): boolean {
    const parent = parentOfVersion(threadRows(rows), ofUuid)
    if (parent === undefined) return false
    this.pending.set(conversationId, parent)
    return true
  }

  /** The parent a new version of `ofUuid` takes, or undefined when it is not stored. */
  versionParent(rows: readonly ThreadStoredRow[], ofUuid: string): string | undefined {
    return parentOfVersion(threadRows(rows), ofUuid)
  }

  /** Choose the version `direction` steps from `uuid`; the row whose context changes. */
  select<T extends ThreadStoredRow>(
    rows: readonly T[],
    uuid: string,
    direction: number
  ): T | undefined {
    const target = neighbourVersion(threadRows(rows), uuid, direction)
    const row = rows.find((entry) => uuidOf(entry) === target)
    if (row) row.context = { ...contextOf(row), selectedAt: nextChoice() }
    return row
  }
}
