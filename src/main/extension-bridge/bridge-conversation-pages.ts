import { getDB, getRagConversation, getRagMessages, searchRagConversationPage } from '../database'
import {
  conversationSnippet,
  originOf,
  sqlTime,
  readConversationCursor,
  toBridgeConversation,
  writeConversationCursor,
  type ConversationListParams,
  type ConversationSearchParams,
  type ConversationSearchResult,
  type ConversationPage
} from './bridge-conversations'

/** Select from the same unrestricted Desktop-owned scope as the legacy bridge list. */
export function conversationPageSelection(
  params: ConversationListParams,
  query: string | null
): {
  rows: { id: string; updated_at: string; excerpt?: string }[]
  nextCursor?: string
} {
  const cursor = readConversationCursor(params.cursor, query)
  const limit = params.limit ?? (query === null ? 100 : 30)
  const rows =
    query === null
      ? (getDB()
          .prepare(
            `SELECT id, updated_at FROM rag_conversations
        ${cursor ? 'WHERE updated_at < ? OR (updated_at = ? AND id < ?)' : ''}
        ORDER BY updated_at DESC, id DESC LIMIT ?`
          )
          .all(...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []), limit + 1) as {
          id: string
          updated_at: string
          excerpt?: string
        }[])
      : searchRagConversationPage(query, limit + 1, cursor)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    rows: page,
    ...(rows.length > limit && last
      ? {
          nextCursor: writeConversationCursor({ id: last.id, updatedAt: last.updated_at }, query)
        }
      : {})
  }
}

/** Search summaries never load message content or image attachments into the page. */
export function plainConversationSearchPage(
  params: ConversationSearchParams
): ConversationSearchResult {
  const cursor = readConversationCursor(params.cursor, params.query)
  const limit = params.limit ?? 30
  const rows = searchRagConversationPage(params.query, limit + 1, cursor)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    conversations: page.map((row) => ({
      id: row.id,
      title: row.title || row.fallback_title?.slice(0, 48) || 'Chat',
      createdAt: sqlTime(row.created_at),
      updatedAt: sqlTime(row.updated_at),
      origin: originOf(row),
      snippet: conversationSnippet(row.excerpt, params.query),
      turnCount: row.turn_count
    })),
    ...(rows.length > limit && last
      ? {
          nextCursor: writeConversationCursor(
            { id: last.id, updatedAt: last.updated_at },
            params.query
          )
        }
      : {})
  }
}

export function plainConversationPage(params: ConversationSearchParams): ConversationSearchResult
export function plainConversationPage(params: ConversationListParams): ConversationPage
export function plainConversationPage(
  params: ConversationListParams | ConversationSearchParams
): ConversationPage | ConversationSearchResult {
  if ('query' in params) return plainConversationSearchPage(params)
  const { rows, nextCursor } = conversationPageSelection(params, null)
  return {
    conversations: rows.map((hit) =>
      toBridgeConversation(getRagConversation(hit.id)!, getRagMessages(hit.id))
    ),
    ...(nextCursor ? { nextCursor } : {})
  }
}
