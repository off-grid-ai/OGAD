import { useEffect, useState, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import ReactMarkdown from 'react-markdown'
import { openChatLink } from '@renderer/lib/chat-link'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { parseSqliteUtc } from '@renderer/lib/time'
import { parseSessionId } from '@renderer/lib/session-id'
import { Modal, ModalBody, ModalContent, ModalTrigger } from './ui/animated-modal'
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from './ui/item'
import { BorderBeam } from './ui/border-beam'
import { ProgressiveBlur } from './ui/progressive-blur'
import { SourceFilterTabs, Source } from './SourceFilterTabs'
import { cn } from '@renderer/lib/utils'

interface ChatSession {
  session_id: string
  last_activity: string
  memory_count: number
  entity_count: number
  summary: string | null
}

interface ChatListProps {
  onSelectSession: (sessionId: string) => void
}

interface ChatListItemProps {
  session: ChatSession
  index: number
  formattedTime: string
  onSelect: (sessionId: string) => void
  onDelete: (e: React.MouseEvent, sessionId: string) => void
}

function ChatListItem({ session, index, formattedTime, onSelect, onDelete }: ChatListItemProps) {
  const { readableTitle, llmLabel } = parseSessionId(session.session_id)

  // Glare effect state
  const containerRef = useRef<HTMLDivElement>(null)
  const isPointerInside = useRef(false)
  const [glareStyle, setGlareStyle] = useState({ x: 50, y: 50, opacity: 0, rotateX: 0, rotateY: 0 })

  const handlePointerMove = (event: React.PointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * 100
    const y = ((event.clientY - rect.top) / rect.height) * 100
    // Calculate subtle rotation based on mouse position
    const rotateY = ((x - 50) / 50) * 3 // max 3 degrees
    const rotateX = ((y - 50) / 50) * -2 // max 2 degrees, inverted
    setGlareStyle({ x, y, opacity: 0.15, rotateX, rotateY })
  }

  const handlePointerEnter = () => {
    isPointerInside.current = true
    setGlareStyle((prev) => ({ ...prev, opacity: 0.15 }))
  }

  const handlePointerLeave = () => {
    isPointerInside.current = false
    setGlareStyle({ x: 50, y: 50, opacity: 0, rotateX: 0, rotateY: 0 })
  }

  const markdownComponents: Record<string, React.ComponentType<any>> = {
    p: ({ children }: { children?: React.ReactNode }) => (
      <p className="mb-3 last:mb-0 text-neutral-200">{children}</p>
    ),
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <a
        href={href}
        className="text-emerald-400 underline"
        onClick={(event) => {
          event.preventDefault()
          openChatLink(href)
        }}
      >
        {children}
      </a>
    ),
    code: ({ inline, children }: { inline?: boolean; children?: React.ReactNode }) => (
      <code
        className={
          inline
            ? 'rounded bg-white/10 px-1.5 py-0.5 text-[0.85em]'
            : 'block whitespace-pre-wrap rounded-lg bg-white/10 p-3 text-[0.85em]'
        }
      >
        {children}
      </code>
    ),
    pre: ({ children }: { children?: React.ReactNode }) => (
      <pre className="mb-3 overflow-x-auto">{children}</pre>
    ),
    ul: ({ children }: { children?: React.ReactNode }) => (
      <ul className="mb-3 list-disc pl-6 text-neutral-200">{children}</ul>
    ),
    ol: ({ children }: { children?: React.ReactNode }) => (
      <ol className="mb-3 list-decimal pl-6 text-neutral-200">{children}</ol>
    ),
    li: ({ children }: { children?: React.ReactNode }) => <li className="mb-1">{children}</li>,
    strong: ({ children }: { children?: React.ReactNode }) => (
      <strong className="font-semibold text-white">{children}</strong>
    ),
    em: ({ children }: { children?: React.ReactNode }) => (
      <em className="text-neutral-300">{children}</em>
    ),
    blockquote: ({ children }: { children?: React.ReactNode }) => (
      <blockquote className="mb-3 border-l-2 border-neutral-700 pl-4 text-neutral-300">
        {children}
      </blockquote>
    ),
    h1: ({ children }: { children?: React.ReactNode }) => (
      <h1 className="mb-2 text-lg font-semibold text-white">{children}</h1>
    ),
    h2: ({ children }: { children?: React.ReactNode }) => (
      <h2 className="mb-2 text-base font-semibold text-white">{children}</h2>
    ),
    h3: ({ children }: { children?: React.ReactNode }) => (
      <h3 className="mb-2 text-sm font-semibold text-white">{children}</h3>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
    >
      {/* 3D transformed card container */}
      <div
        ref={containerRef}
        className="relative rounded-lg"
        style={{
          transform: `perspective(800px) rotateX(${glareStyle.rotateX}deg) rotateY(${glareStyle.rotateY}deg)`,
          transition: 'transform 0.2s ease-out'
        }}
        onPointerMove={handlePointerMove}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        {/* Glare overlay */}
        <div
          className="pointer-events-none absolute inset-0 z-10 transition-opacity duration-300 rounded-lg"
          style={{
            background: `radial-gradient(circle at ${glareStyle.x}% ${glareStyle.y}%, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.05) 40%, rgba(255,255,255,0) 70%)`,
            opacity: glareStyle.opacity
          }}
        />
        {/* Subtle shimmer effect */}
        <div
          className="pointer-events-none absolute inset-0 z-10 mix-blend-overlay transition-opacity duration-300 rounded-lg"
          style={{
            background: `
                            radial-gradient(circle at ${glareStyle.x}% ${glareStyle.y}%, 
                                rgba(255,255,255,0.08) 0%,
                                rgba(255,255,255,0.04) 40%,
                                transparent 70%
                            )
                        `,
            opacity: glareStyle.opacity * 1.5
          }}
        />
        <Item
          variant="outline"
          className="group cursor-pointer hover:border-neutral-700 relative"
          onClick={() => onSelect(session.session_id)}
        >
          <ItemContent>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-neutral-800 text-neutral-300 border border-neutral-700">
                {llmLabel}
              </span>
              <ItemTitle>{readableTitle}</ItemTitle>
            </div>
          </ItemContent>

          <ItemActions className="gap-3">
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <span className="px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 border border-neutral-700">
                {session.memory_count} {session.memory_count === 1 ? 'memory' : 'memories'}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 border border-neutral-700">
                {session.entity_count} {session.entity_count === 1 ? 'entity' : 'entities'}
              </span>
              <span className="text-neutral-600">•</span>
              <span>{formattedTime}</span>
            </div>

            <div className="flex items-center gap-2">
              {session.summary && (
                <div onClick={(e) => e.stopPropagation()}>
                  <Modal>
                    <ModalTrigger className="h-8 w-8 rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-white hover:border-neutral-700 p-0 flex items-center justify-center">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-4 w-4"
                      >
                        <path d="M8 6h8" />
                        <path d="M8 10h8" />
                        <path d="M8 14h5" />
                        <path d="M6 3h9l3 3v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                      </svg>
                    </ModalTrigger>
                    {/* Modal rendered OUTSIDE the 3D transformed container */}
                    <ModalBody className="bg-neutral-950 border-neutral-800 max-h-[80vh]">
                      <ModalContent className="p-6 text-neutral-200 overflow-y-auto">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-base font-semibold text-white">
                              {readableTitle} - Summary
                            </div>
                            <div className="mt-1 text-xs text-neutral-500">{llmLabel}</div>
                          </div>
                          <button
                            onClick={async () => {
                              if (session.summary) {
                                await navigator.clipboard.writeText(session.summary)
                              }
                            }}
                            className="h-8 w-8 rounded-lg border border-neutral-700 bg-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-600 transition-colors flex items-center justify-center"
                            title="Copy to clipboard"
                          >
                            <svg
                              className="w-4 h-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                            </svg>
                          </button>
                        </div>
                        <div className="mt-4 border-t border-neutral-800 pt-4 text-sm leading-relaxed text-neutral-200">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkBreaks]}
                            components={markdownComponents}
                          >
                            {session.summary}
                          </ReactMarkdown>
                        </div>
                        <div className="mt-5 text-xs text-neutral-500">{session.session_id}</div>
                        <BorderBeam
                          duration={4}
                          size={400}
                          borderWidth={2}
                          className="from-transparent via-neutral-500 to-transparent"
                        />
                        <BorderBeam
                          duration={4}
                          delay={1}
                          size={400}
                          borderWidth={2}
                          className="from-transparent via-neutral-600 to-transparent"
                        />
                      </ModalContent>
                    </ModalBody>
                  </Modal>
                </div>
              )}

              <button
                onClick={(e) => onDelete(e, session.session_id)}
                className="h-8 w-8 rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-500 hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/40 transition-all flex items-center justify-center"
                title="Delete"
              >
                ×
              </button>
            </div>
          </ItemActions>
        </Item>
      </div>
    </motion.div>
  )
}

export function ChatList({ onSelectSession }: ChatListProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [activeSource, setActiveSource] = useState<Source>('All')

  const fetchSessions = useCallback(async () => {
    setLoading(true)
    try {
      const data = await window.api.getChatSessions(activeSource)
      setSessions(data)
    } catch (e) {
      console.error('Failed to fetch sessions', e)
    } finally {
      setLoading(false)
    }
  }, [activeSource])

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await fetchSessions()
    setIsRefreshing(false)
  }

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    if (!confirm('Are you sure you want to delete this chat?')) return

    try {
      await window.api.deleteSession(sessionId)
      setSessions((prev) => prev.filter((s) => s.session_id !== sessionId))
    } catch (e) {
      console.error('Failed to delete', e)
    }
  }

  // Filter sessions locally
  const filteredSessions = sessions.filter(
    (s) =>
      s.session_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.summary && s.summary.toLowerCase().includes(searchQuery.toLowerCase()))
  )

  const formatTime = (dateStr: string): string => {
    // SQLite "YYYY-MM-DD HH:MM:SS" is UTC — parsed via the shared lib/time helper.
    // Format with explicit fields (date + HH:MM, no seconds) rather than slicing
    // toLocaleString() at fixed offsets, which truncates/breaks in non-US locales.
    return parseSqliteUtc(dateStr).toLocaleString(undefined, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Source Filter Tabs */}
      <SourceFilterTabs
        activeSource={activeSource}
        onSourceChange={(source) => {
          setActiveSource(source)
          setSearchQuery('')
        }}
      />

      {/* Search Bar with Refresh Button */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500"
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
            type="text"
            placeholder="Search chats..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-3 rounded-xl bg-neutral-900/80 border border-neutral-800 text-white placeholder-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors"
          />
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing || loading}
          className={cn(
            'h-[46px] w-[46px] rounded-xl border border-neutral-800 bg-neutral-900/80',
            'text-neutral-400 hover:text-white hover:border-neutral-600',
            'flex items-center justify-center transition-all',
            (isRefreshing || loading) && 'opacity-50 cursor-not-allowed'
          )}
          title="Refresh"
        >
          <svg
            className={cn('w-5 h-5', (isRefreshing || loading) && 'animate-spin')}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-neutral-600 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 overflow-y-auto pb-16">
          <ItemGroup>
            <AnimatePresence mode="popLayout">
              {filteredSessions.map((session, index) => (
                <ChatListItem
                  key={session.session_id}
                  session={session}
                  index={index}
                  formattedTime={formatTime(session.last_activity)}
                  onSelect={onSelectSession}
                  onDelete={handleDelete}
                />
              ))}
            </AnimatePresence>
          </ItemGroup>

          {!loading && filteredSessions.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-16 h-16 rounded-2xl bg-neutral-800 flex items-center justify-center mb-4">
                <svg
                  className="w-8 h-8 text-neutral-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
              </div>
              <p className="text-neutral-500">No chats found</p>
            </div>
          )}
        </div>

        {filteredSessions.length > 3 && (
          <ProgressiveBlur height="80px" position="bottom" className="pointer-events-none" />
        )}
      </div>
    </div>
  )
}
