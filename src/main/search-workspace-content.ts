/**
 * Chat facts for universal search, projected from the CANONICAL Workspace Content snapshot.
 *
 * Universal search used to read `rag_conversations` / `rag_messages` directly, which made global
 * search a second reader of the legacy transcript and let it disagree with the canonical owner
 * (a renamed chat, a synced message, a compacted turn). This module is the only chat reader left
 * in search: `workspaceChatSnapshot` is the one thin read of the canonical owner, and everything
 * above it is PURE over the snapshot the caller already holds. The same projection serves the
 * source counts, the facet counts and the ranked hits, so a facet count can never diverge from
 * the results it labels.
 *
 * The observable facts are unchanged from the legacy SQL: key `chat:<conversationId>`, kind
 * `chat`, refId 0, `Chat` surface, the conversation id in `url` (the renderer's open target),
 * the conversation's `updated_at` in epoch milliseconds, a 300-character snippet, and newest
 * conversation first.
 */
import type {
  ConversationRecord,
  MessageRecord,
  WorkspaceContentSnapshot
} from '@offgrid/application'
import {
  desktopWorkspaceContent,
  reportDesktopApplicationDegraded
} from './composition/application-access'
import { writeDiagnosticLog } from './diagnostics-log'
import type { RawHit } from './search-ranking'

/** The snapshot facts this projection reads. Narrower than the facade, so it stays testable. */
export type WorkspaceChatSnapshot = Pick<
  WorkspaceContentSnapshot,
  'status' | 'conversations' | 'messages'
>

const SNIPPET_LENGTH = 300

/**
 * Epoch milliseconds for a canonical record timestamp, matching the SQL this replaced
 * (`CAST(strftime('%s', col) AS INTEGER)*1000`). SQLite reads its space-separated datetime as
 * UTC, so a value without a zone is normalized to UTC rather than the device's local time —
 * otherwise every pre-migration chat's recency boost would shift by the machine's offset.
 * An unparseable value scores 0, exactly as a NULL column did.
 */
export function chatTimestampMs(value: string): number {
  const trimmed = value.trim()
  if (!trimmed) return 0
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

/** One message's searchable plain text. Rich content contributes its text parts only. */
export function messageSearchText(message: MessageRecord): string {
  const content = message.portable.content
  if (typeof content === 'string') return content
  return content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
}

/**
 * The legacy match, term for term: every term must appear as a substring of THIS message's text
 * or of its conversation's title (the title joined into each row, so it satisfies any term).
 */
function messageMatches(text: string, title: string, terms: readonly string[]): boolean {
  const haystack = text.toLowerCase()
  const titleText = title.toLowerCase()
  return terms.every((term) => haystack.includes(term) || titleText.includes(term))
}

interface ConversationMatch {
  readonly conversation: ConversationRecord
  readonly snippet: string
}

/**
 * Matching conversations, newest first, each with the snippet of its earliest matching message.
 * One pass over the transcript in stable `position` order keeps the snippet deterministic — the
 * `GROUP BY` it replaced returned an arbitrary row from the group.
 */
function matchingConversations(
  snapshot: WorkspaceChatSnapshot,
  terms: readonly string[]
): ConversationMatch[] {
  if (!terms.length) return []
  const conversations = new Map(snapshot.conversations.map((record) => [record.id, record]))
  const snippets = new Map<string, { position: number; snippet: string }>()
  for (const message of snapshot.messages) {
    const conversation = conversations.get(message.conversationId)
    if (!conversation) continue
    const text = messageSearchText(message)
    if (!messageMatches(text, conversation.title, terms)) continue
    const best = snippets.get(conversation.id)
    if (best && best.position <= message.position) continue
    snippets.set(conversation.id, {
      position: message.position,
      snippet: text.slice(0, SNIPPET_LENGTH)
    })
  }
  return [...snippets.entries()]
    .map(([id, best]) => ({ conversation: conversations.get(id)!, snippet: best.snippet }))
    .sort((a, b) => b.conversation.updatedAt.localeCompare(a.conversation.updatedAt))
}

/** How many conversations exist — the unfiltered `Chat` source count. */
export function chatSourceCount(snapshot: WorkspaceChatSnapshot): number {
  return snapshot.conversations.length
}

/** How many conversations match — the `Chat` facet count for the current query. */
export function chatFacetCount(snapshot: WorkspaceChatSnapshot, terms: readonly string[]): number {
  return matchingConversations(snapshot, terms).length
}

/** Ranked-search input: one hit per matching conversation, newest first, bounded by `limit`. */
export function chatSearchHits(
  snapshot: WorkspaceChatSnapshot,
  terms: readonly string[],
  limit: number
): RawHit[] {
  return matchingConversations(snapshot, terms)
    .slice(0, limit)
    .map(({ conversation, snippet }) => ({
      key: `chat:${conversation.id}`,
      kind: 'chat' as const,
      refId: 0,
      title: conversation.title || 'Chat',
      snippet,
      surface: 'Chat',
      url: conversation.id,
      ts: chatTimestampMs(conversation.updatedAt)
    }))
}

/** The same, for the chat half: one key, so "chats are not searchable yet" clears when they are. */
export const CHAT_SEARCH_DEGRADATION_SOURCE = 'search-chat'

/**
 * The canonical chat content this search may read, or `null` when its owner is not ready.
 *
 * Chat facts have ONE owner. Universal search is a reader of that owner and holds no second copy,
 * so before Workspace Content has loaded there is nothing to search - and there is deliberately no
 * fallback to the legacy transcript tables, because a second reader is exactly the divergence this
 * cutover removes. The other sources (screen, memory, meetings, knowledge base) are unaffected and
 * still answer, so this returns `null` rather than failing a search the rest of the index can
 * serve. The absence is PUBLISHED, not swallowed: without it, "your chats are still loading" and
 * "no chat matched" would look identical to the user.
 */
export function workspaceChatSnapshot(): WorkspaceChatSnapshot | null {
  let snapshot: WorkspaceChatSnapshot | null = null
  let reason: string | null = null
  try {
    const current = desktopWorkspaceContent.snapshot()
    if (current.status === 'ready') snapshot = current
    else reason = `Chat search did not run: workspace content is ${current.status}.`
  } catch (error) {
    reason = `Chat search did not run: ${failureMessage(error)}`
  }
  // Observation must never change the outcome of the work it observes - the same trade, and the
  // same reasoning, as `reportSemanticStatus` in `search.ts`.
  try {
    reportDesktopApplicationDegraded({
      domain: 'rag',
      source: CHAT_SEARCH_DEGRADATION_SOURCE,
      reason
    })
    if (reason !== null) writeDiagnosticLog('search', 'chat.unavailable', { reason }, 'error')
  } catch {
    /* swallow: reporting a degradation must not be able to fail the search it observed */
  }
  return snapshot
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
