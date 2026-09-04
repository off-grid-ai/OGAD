import { memo, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { timeAgo } from '@renderer/lib/time'
import { chatListPreviewLine } from '@offgrid/application'
import { filterConversations, groupConversationsByRecency } from '@renderer/lib/conversation-groups'
import { ConversationTitleActions } from './ConversationTitleActions'
import type { Conversation } from '@renderer/lib/chat-transcript-types'
import type { RagConversationContract } from '../../../shared/ipc-contracts'

/** How long a typed query waits before the backend is asked about message content. */
const CONTENT_SEARCH_DELAY_MS = 200

const EMPTY_IDS: ReadonlySet<string> = new Set<string>()

interface ConversationSearchListProps {
  readonly conversations: readonly Conversation[]
  readonly activeConversationId: string | null
  readonly onSelect: (id: string) => void
  readonly onRenamed: (conversation: RagConversationContract) => void
  readonly onDelete: (id: string) => void
}

/**
 * The sidebar's conversation search and list.
 *
 * The query used to live in the chat screen, so every character re-rendered the transcript, the
 * composer and every panel around them - the list is the only thing a query changes. It lives here
 * now: typing re-renders this leaf, the content search behind it is deferred and latest-wins, and
 * an older result can never replace a newer one.
 */
function ConversationSearchListInner({
  conversations,
  activeConversationId,
  onSelect,
  onRenamed,
  onDelete
}: ConversationSearchListProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  // Filtering yields to typing: the keystroke paints first, the list catches up.
  const deferredQuery = useDeferredValue(query)
  // Conversation ids whose MESSAGE CONTENT matches. Titles are matched here; content needs a
  // backend query, so it is deferred and cancellable. The answer is kept WITH the query it
  // answered, so a result for text the user has moved on from can never be applied to what they
  // are typing now.
  const [contentMatches, setContentMatches] = useState<{
    query: string
    ids: ReadonlySet<string>
  }>({ query: '', ids: EMPTY_IDS })

  const trimmedQuery = deferredQuery.trim()

  useEffect(() => {
    if (!trimmedQuery) return
    let live = true
    const timer = setTimeout(async () => {
      try {
        const ids = await window.api.searchRagConversationIds(trimmedQuery)
        if (live) setContentMatches({ query: trimmedQuery, ids: new Set(ids ?? []) })
      } catch {
        /* keep title-only matches */
      }
    }, CONTENT_SEARCH_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [trimmedQuery])

  const groups = useMemo(() => {
    const ids = contentMatches.query === trimmedQuery ? contentMatches.ids : EMPTY_IDS
    const matches = filterConversations(conversations, trimmedQuery, ids)
    return { matches, bands: groupConversationsByRecency(matches, new Date()) }
  }, [conversations, trimmedQuery, contentMatches])

  return (
    <>
      {conversations.length > 0 && (
        <div className="px-2 pb-2">
          <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 focus-within:border-neutral-600">
            <svg
              className="h-3.5 w-3.5 shrink-0 text-neutral-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations…"
              className="w-full bg-transparent text-xs text-neutral-200 placeholder-neutral-600 outline-none"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="shrink-0 text-neutral-600 hover:text-neutral-300"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-neutral-600">No conversations yet</p>
        ) : groups.matches.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-neutral-600">No matches</p>
        ) : (
          groups.bands.map((g) => (
            <div key={g.label} className="mb-2">
              <div className="px-1 py-1 text-[10px] uppercase tracking-wider text-neutral-600">
                {g.label}
              </div>
              {g.items.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => onSelect(conv.id)}
                  className={`group flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
                    activeConversationId === conv.id
                      ? 'border-neutral-800 bg-neutral-900'
                      : 'border-transparent hover:bg-neutral-900/50'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <ConversationTitleActions
                      conversation={conv}
                      onRenamed={onRenamed}
                      onDelete={() => onDelete(conv.id)}
                    />
                    {/* The last thing said, from the shared rule the phone's list uses. A title
                        alone told you nothing about a conversation you had elsewhere. */}
                    {chatListPreviewLine(conv.last_role, conv.last_content) ? (
                      <p className="mt-0.5 truncate text-[11px] text-neutral-500">
                        {chatListPreviewLine(conv.last_role, conv.last_content)}
                      </p>
                    ) : null}
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="text-[10px] text-neutral-600">
                        {timeAgo(conv.updated_at)}
                      </span>
                      {conv.project_id && (
                        <span className="text-[10px] text-green-500/70">project</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  )
}

export const ConversationSearchList = memo(ConversationSearchListInner)
