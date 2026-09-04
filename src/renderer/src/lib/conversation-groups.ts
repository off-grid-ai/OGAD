import { parseSqliteUtc, shiftLocalDay, startOfLocalDay } from './time'
import type { Conversation } from './chat-transcript-types'

export interface ConversationGroup {
  readonly label: string
  readonly items: readonly Conversation[]
}

/**
 * Which conversations a search matches: the title, matched here, or the message content, matched by
 * the backend and handed in as ids.
 */
export function filterConversations(
  conversations: readonly Conversation[],
  query: string,
  contentMatchIds: ReadonlySet<string>
): readonly Conversation[] {
  const q = query.trim().toLowerCase()
  if (!q) return conversations
  return conversations.filter(
    (c) => (c.title || '').toLowerCase().includes(q) || contentMatchIds.has(c.id)
  )
}

/**
 * Conversations newest first, in the recency bands the sidebar shows.
 *
 * Every timestamp is read through parseSqliteUtc, the SAME parser the row's label uses. These are
 * UTC with no zone marker, and `new Date('2026-08-10 14:00:00')` reads a space-separated string as
 * LOCAL - so the position said one thing and the words said another, off by the whole timezone
 * offset. In IST that put "just now" below "5h ago" and dropped this morning's chats into Yesterday.
 */
export function groupConversationsByRecency(
  conversations: readonly Conversation[],
  now: Date
): readonly ConversationGroup[] {
  const today = startOfLocalDay(now)
  const startToday = today.getTime()
  const startYesterday = shiftLocalDay(today, -1).getTime()
  const startThisWeek = shiftLocalDay(today, -6).getTime()
  const groups: { label: string; items: Conversation[] }[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'This week', items: [] },
    { label: 'Older', items: [] }
  ]
  const ordered = [...conversations].sort(
    (a, b) => parseSqliteUtc(b.updated_at).getTime() - parseSqliteUtc(a.updated_at).getTime()
  )
  for (const c of ordered) {
    const t = parseSqliteUtc(c.updated_at).getTime()
    if (t >= startToday) groups[0]!.items.push(c)
    else if (t >= startYesterday) groups[1]!.items.push(c)
    else if (t >= startThisWeek) groups[2]!.items.push(c)
    else groups[3]!.items.push(c)
  }
  return groups.filter((g) => g.items.length > 0)
}
