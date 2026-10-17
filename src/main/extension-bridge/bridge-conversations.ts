// Mapping between OGAD's chat tables (rag_conversations / rag_messages) and the conversation
// shape the extension syncs. Pure, unit-tested.
//
// Writes from a browser are APPEND-ONLY: a push adds the turns the desktop does not have yet
// and never edits or removes what is already stored, so a stale browser can't erase a chat.

export interface BridgeTurn {
  readonly role: 'user' | 'assistant'
  readonly content: string
  /** The stored message's id, so a browser can choose one of its versions. */
  readonly id?: string
  /** Where this turn sits among its versions (0-based), when a retry or an edit added others. */
  readonly versions?: { readonly index: number; readonly count: number }
}

export interface BridgeConversation {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly origin: 'browser' | 'desktop' | 'mobile'
  readonly turns: readonly BridgeTurn[]
  /** Every stored turn, so a browser can number a window of the latest turns. */
  readonly turnCount?: number
}

interface ConversationRow {
  readonly id: string
  readonly title?: string | null
  readonly origin_device_id?: string | null
  readonly created_at?: string | null
  readonly updated_at?: string | null
}

interface MessageRow {
  readonly role: string
  readonly content: string
  readonly uuid?: string | null
  readonly versions?: { readonly index: number; readonly count: number }
}

/** Browser-origin conversations are tagged so their origin survives the round trip. */
export const BROWSER_ORIGIN_PREFIX = 'browser:'

/** Tag a newly created conversation with the browser that owns it. */
export function setBrowserConversationOrigin(
  db: { prepare(sql: string): { run(origin: string, name: string, id: string): unknown } },
  conversationId: string,
  browser: { id: string; name: string }
): void {
  db.prepare(
    'UPDATE rag_conversations SET origin_device_id = ?, origin_device_name = ? WHERE id = ?'
  ).run(`${BROWSER_ORIGIN_PREFIX}${browser.id}`, browser.name, conversationId)
}

export const MAX_LISTED = 100
export const MAX_TURNS = 40
export const MAX_TURN_CHARS = 20_000

/** SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) to epoch ms; 0 when unreadable. */
export function sqlTime(value: string | null | undefined): number {
  if (!value) return 0
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

export function originOf(row: ConversationRow): BridgeConversation['origin'] {
  const device = row.origin_device_id
  if (!device) return 'desktop'
  return device.startsWith(BROWSER_ORIGIN_PREFIX) ? 'browser' : 'mobile'
}

export function toBridgeConversation(
  row: ConversationRow,
  messages: readonly MessageRow[]
): BridgeConversation {
  const stored = messages.filter(
    (m): m is MessageRow & { role: 'user' | 'assistant' } =>
      m.role === 'user' || m.role === 'assistant'
  )
  const turns: BridgeTurn[] = stored.slice(-MAX_TURNS).map((m) => ({
    role: m.role,
    content: m.content.slice(0, MAX_TURN_CHARS),
    ...(m.uuid ? { id: m.uuid } : {}),
    ...(m.versions ? { versions: { index: m.versions.index, count: m.versions.count } } : {})
  }))
  return {
    id: row.id,
    title: row.title || turns.find((t) => t.role === 'user')?.content.slice(0, 48) || 'Chat',
    createdAt: sqlTime(row.created_at),
    updatedAt: sqlTime(row.updated_at),
    origin: originOf(row),
    turns,
    turnCount: stored.length
  }
}

const ID = /^[A-Za-z0-9_-]{8,64}$/

/** Validate a conversation a browser pushed. Field by field; null on anything malformed. */
export function parseBridgeConversation(raw: unknown): BridgeConversation | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  if (typeof c.id !== 'string' || !ID.test(c.id) || typeof c.title !== 'string') return null
  if (!Array.isArray(c.turns) || c.turns.length > MAX_TURNS * 4) return null
  const turns: BridgeTurn[] = []
  for (const t of c.turns) {
    const turn = t as Record<string, unknown> | null
    if ((turn?.role !== 'user' && turn?.role !== 'assistant') || typeof turn.content !== 'string') {
      return null
    }
    turns.push({ role: turn.role, content: turn.content.slice(0, MAX_TURN_CHARS) })
  }
  return {
    id: c.id,
    title: c.title.slice(0, 200),
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
    updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0,
    origin: 'browser',
    turns
  }
}

/**
 * The turns to append so the desktop catches up with the browser. The browser keeps only its
 * latest turns, so what it sends is a window: the end of the desktop's stored turns must match the
 * start of that window, and whatever follows the overlap is new. The longest overlap wins, so a
 * repeated short turn never makes old turns look new. With no overlap (a diverged or stale
 * history) nothing is appended, so the desktop's copy is never contradicted.
 */
export function turnsToAppend(
  stored: readonly MessageRow[],
  incoming: readonly BridgeTurn[]
): BridgeTurn[] {
  const have = stored.filter((m) => m.role === 'user' || m.role === 'assistant')
  if (!have.length) return [...incoming]
  const same = (m: MessageRow, turn: BridgeTurn | undefined): boolean =>
    turn !== undefined &&
    m.role === turn.role &&
    m.content.slice(0, MAX_TURN_CHARS) === turn.content
  for (let overlap = Math.min(have.length, incoming.length); overlap > 0; overlap--) {
    const tail = have.slice(have.length - overlap)
    if (tail.every((m, i) => same(m, incoming[i]))) return incoming.slice(overlap)
  }
  return []
}

/**
 * Whether a browser's history contradicts the desktop's: it neither continues the stored turns
 * (turnsToAppend) nor is an older window of them. An edited or regenerated turn reads this way.
 * The desktop has no record of what the browser saw last, so it cannot tell an edit from turns
 * added here since, and refuses rather than overwrite either one.
 */
export function historyConflicts(
  stored: readonly MessageRow[],
  incoming: readonly BridgeTurn[]
): boolean {
  const have = stored.filter((m) => m.role === 'user' || m.role === 'assistant')
  if (!have.length || !incoming.length || turnsToAppend(stored, incoming).length) return false
  const same = (m: MessageRow, turn: BridgeTurn): boolean =>
    m.role === turn.role && m.content.slice(0, MAX_TURN_CHARS) === turn.content
  for (let start = 0; start + incoming.length <= have.length; start++) {
    if (incoming.every((turn, i) => same(have[start + i]!, turn))) return false
  }
  return true
}

/** The title a browser renamed its chat to, when that rename is newer than the desktop's copy. */
export function newerBrowserTitle(
  row: ConversationRow,
  conversation: BridgeConversation
): string | null {
  const title = conversation.title.trim()
  if (!title || title === (row.title ?? '')) return null
  return conversation.updatedAt > sqlTime(row.updated_at) ? title : null
}

/** What a refused browser edit says: the extension keeps an edit whose refusal names a conflict. */
export const HISTORY_CONFLICT =
  'conflict: this chat changed differently on the desktop, so the edit was kept in the browser'

export type BridgeListedConversation = Omit<BridgeConversation, 'turns'> & {
  readonly turns: (BridgeTurn & { readonly image?: string })[]
}
export type BridgeConversationSearchHit = Omit<BridgeConversation, 'turns'> & {
  readonly snippet: string
  readonly turnCount: number
}
export type ConversationSearchResult = ConversationPage<BridgeConversationSearchHit>

export interface ConversationListParams {
  readonly limit?: number
  readonly cursor?: string
}
export interface ConversationSearchParams extends ConversationListParams {
  readonly query: string
}
export interface ConversationPage<T = BridgeConversation> {
  readonly conversations: T[]
  readonly nextCursor?: string
}
export interface ConversationCursor {
  readonly updatedAt: string
  readonly id: string
}

/** No parameters keeps the original list response. A parameter opts into pages. */
export function parseConversationParams(
  params: Record<string, unknown>,
  search: boolean
): ConversationSearchParams | ConversationListParams {
  const allowed = search ? ['query', 'limit', 'cursor'] : ['limit', 'cursor']
  if (Object.keys(params).some((key) => !allowed.includes(key))) throw new Error('invalid')
  if (
    params.limit !== undefined &&
    (typeof params.limit !== 'number' ||
      !Number.isInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > (search ? 50 : MAX_LISTED))
  )
    throw new Error('invalid')
  if (params.cursor !== undefined && typeof params.cursor !== 'string') throw new Error('invalid')
  const page = {
    limit: (params.limit as number | undefined) ?? (search ? 30 : MAX_LISTED),
    ...(params.cursor !== undefined ? { cursor: params.cursor as string } : {})
  }
  if (!search) return page
  if (typeof params.query !== 'string') throw new Error('invalid')
  const query = params.query.trim()
  if (!query || query.length > 500) throw new Error('invalid')
  return { ...page, query }
}

/** Bind a keyset cursor to its operation and query, and preserve timestamp ties. */
export function readConversationCursor(
  cursor: string | undefined,
  query: string | null
): ConversationCursor | undefined {
  if (cursor === undefined) return undefined
  try {
    if (!cursor || cursor.length > 4000) throw new Error('invalid')
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      value.v !== 1 ||
      value.query !== query ||
      typeof value.updatedAt !== 'string' ||
      typeof value.id !== 'string' ||
      !value.id ||
      !value.updatedAt
    )
      throw new Error('invalid')
    return { updatedAt: value.updatedAt, id: value.id }
  } catch {
    throw new Error('invalid')
  }
}

export function writeConversationCursor(row: ConversationCursor, query: string | null): string {
  return Buffer.from(JSON.stringify({ v: 1, query, ...row })).toString('base64url')
}

/** Strip tags until none is left, so a nested tag such as <scr<b>ipt> cannot rebuild one. */
function withoutTags(text: string): string {
  let previous: string
  let next = text
  do {
    previous = next
    next = next.replace(/<[^>]*>/g, '')
  } while (next !== previous)
  return next
}

/** Remove stored formatting before selecting a small window around a matched term. */
export function conversationSnippet(excerpt: string, query: string): string {
  const plain = withoutTags(excerpt)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&(?:lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, ' ')
    .replace(/[`*_~#><|[\]]/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const positions = terms.map((term) => plain.toLowerCase().indexOf(term)).filter((n) => n >= 0)
  const start = positions.length ? Math.max(0, Math.min(...positions) - 60) : 0
  return plain.slice(start, start + 200).trim()
}
