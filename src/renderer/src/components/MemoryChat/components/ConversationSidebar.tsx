import { memo, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { chatListPreviewLine } from '@offgrid/sync'
import { Empty, EmptyDescription } from '@offgrid/operator-ui/operator/coss/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput
} from '@offgrid/operator-ui/operator/coss/input-group'
import { Plus } from '@phosphor-icons/react'
import { timeAgo } from '@renderer/lib/time'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
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
  // The text being typed lives here, so a keystroke re-renders this sidebar only. The chat screen
  // receives the query once typing pauses, and a clear or an outside change applies at once.
  const [draft, setDraft] = useState(search)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [settledSearch, setSettledSearch] = useState(search)
  if (search !== settledSearch) {
    setSettledSearch(search)
    setDraft(search)
  }
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current)
    },
    []
  )
  // An outside change to the search wins: a draft still waiting to settle must not overwrite it.
  useEffect(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current)
    settleTimer.current = null
  }, [search])
  const changeDraft = (next: string, immediate = false): void => {
    setDraft(next)
    if (settleTimer.current) clearTimeout(settleTimer.current)
    settleTimer.current = null
    if (immediate) {
      onSearchChange(next)
      return
    }
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null
      onSearchChange(next)
    }, 150)
  }
  const listRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'group' ? 28 : 58),
    // A small gap between rows: lit edges of neighbouring chats never touch. The virtualizer
    // spaces them, so each row's measured size stays its own.
    gap: 4,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 8
  })

  return (
    <aside className="h-full overflow-hidden border-r border-neutral-900">
      <div className="flex h-full min-w-0 flex-col">
        {/* One row: search beside the new-chat action, so the list starts higher. */}
        <div className="flex items-center gap-1.5 px-2 pb-2 pt-3">
          {conversationCount > 0 ? (
            <InputGroup className="min-w-0 flex-1 text-xs">
              <InputGroupAddon>
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
              </InputGroupAddon>
              <InputGroupInput
                size="sm"
                value={draft}
                onChange={(event) => changeDraft(event.target.value)}
                placeholder="Search conversations…"
                className="text-xs"
              />
              {draft && (
                <InputGroupAddon align="inline-end">
                  <button
                    onClick={() => changeDraft('', true)}
                    className="shrink-0 text-neutral-600 hover:text-neutral-300"
                  >
                    ✕
                  </button>
                </InputGroupAddon>
              )}
            </InputGroup>
          ) : (
            <div className="flex-1" />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                aria-label="New chat"
                onClick={onStartNewConversation}
                className="shrink-0 border-neutral-800 text-neutral-300 hover:border-green-500 hover:text-green-500"
              >
                <Plus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New chat</TooltipContent>
          </Tooltip>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto px-2 pb-2">
          {conversationCount === 0 ? (
            <Empty className="flex-none gap-0 px-2 py-4 md:py-4">
              <EmptyDescription className="text-xs text-neutral-600">
                No conversations yet
              </EmptyDescription>
            </Empty>
          ) : rows.length === 0 ? (
            <Empty className="flex-none gap-0 px-2 py-4 md:py-4">
              <EmptyDescription className="text-xs text-neutral-600">No matches</EmptyDescription>
            </Empty>
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
