import { memo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { chatListPreviewLine } from '@offgrid/sync'
import { timeAgo } from '@renderer/lib/time'
import { ConversationTitleActions } from '../../ConversationTitleActions'
import type { ConversationListRow } from '../types'

type ConversationSidebarProps = Readonly<{
  conversationCount: number
  rows: readonly ConversationListRow[]
  search: string
  activeConversationId: string | null
  onSearchChange: (search: string) => void
  onStartNewConversation: () => void
  onSwitchConversation: (conversationId: string, replaceActiveTab: boolean) => void
  onConversationRenamed: Parameters<typeof ConversationTitleActions>[0]['onRenamed']
  onDeleteConversation: (conversationId: string) => void
}>

function ConversationSidebarComponent({
  conversationCount,
  rows,
  search,
  activeConversationId,
  onSearchChange,
  onStartNewConversation,
  onSwitchConversation,
  onConversationRenamed,
  onDeleteConversation
}: ConversationSidebarProps): React.JSX.Element {
  console.log('MemoryChat ConversationSidebar rendered')
  const listRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'group' ? 28 : 58),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 8
  })

  return (
    <aside className="h-full overflow-hidden border-r border-neutral-900">
      <div className="flex h-full min-w-0 flex-col">
        <div className="px-2 pb-2 pt-3">
          <button
            onClick={onStartNewConversation}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-neutral-800 px-3 py-2 text-xs text-neutral-300 transition-colors hover:border-green-500 hover:text-green-500"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            New chat
          </button>
        </div>
        {conversationCount > 0 && (
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
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search conversations…"
                className="w-full bg-transparent text-xs text-neutral-200 placeholder-neutral-600 outline-none"
              />
              {search && (
                <button
                  onClick={() => onSearchChange('')}
                  className="shrink-0 text-neutral-600 hover:text-neutral-300"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        )}
        <div ref={listRef} className="flex-1 overflow-y-auto px-2 pb-2">
          {conversationCount === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-neutral-600">No conversations yet</p>
          ) : rows.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-neutral-600">No matches</p>
          ) : (
            <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index]!
                return (
                  <div
                    key={row.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {row.kind === 'group' ? (
                      <div className="px-1 py-1 text-[10px] uppercase tracking-wider text-neutral-600">
                        {row.label}
                      </div>
                    ) : (
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => onSwitchConversation(row.conversation.id, true)}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onSwitchConversation(row.conversation.id, true)
                          }
                        }}
                        className={`group flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${activeConversationId === row.conversation.id
                          ? 'border-neutral-800 bg-neutral-900'
                          : 'border-transparent hover:bg-neutral-900/50'
                          }`}
                      >
                        <div className="min-w-0 flex-1">
                          <ConversationTitleActions
                            conversation={row.conversation}
                            onRenamed={onConversationRenamed}
                            onDelete={() => onDeleteConversation(row.conversation.id)}
                          />
                          {chatListPreviewLine(
                            row.conversation.last_role,
                            row.conversation.last_content
                          ) ? (
                            <p className="mt-0.5 truncate text-[11px] text-neutral-500">
                              {chatListPreviewLine(
                                row.conversation.last_role,
                                row.conversation.last_content
                              )}
                            </p>
                          ) : null}
                          <div className="mt-0.5 flex items-center gap-2">
                            <span className="text-[10px] text-neutral-600">
                              {timeAgo(row.conversation.updated_at)}
                            </span>
                            {row.conversation.project_id && (
                              <span className="text-[10px] text-green-500/70">project</span>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

export const ConversationSidebar = memo(ConversationSidebarComponent)
