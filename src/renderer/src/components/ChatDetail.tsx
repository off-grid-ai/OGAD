import { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { cn } from '@renderer/lib/utils'
import { parseSqliteUtc } from '@renderer/lib/time'
import { parseSessionId } from '@renderer/lib/session-id'
import { BorderBeam } from './ui/border-beam'
import { ProgressiveBlur } from './ui/progressive-blur'
import { openChatLink } from '@renderer/lib/chat-link'

interface Memory {
  id: number
  content: string
  raw_text: string | null
  source_app: string | null
  session_id: string
  created_at: string
}

interface Entity {
  id: number
  name: string
  type: string
  summary: string | null
  updated_at: string
  fact_count: number
}

interface ChatDetailProps {
  sessionId: string
  onBack: () => void
  onSelectEntity?: (entityId: number) => void
  onSelectMemory?: (memoryId: number) => void
}

type ExpandedSection = 'summary' | 'memories' | 'entities' | null

// Markdown components for summary display
const markdownComponents: Components = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-2 last:mb-0 text-neutral-200 text-sm">{children}</p>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      className="text-neutral-300 underline hover:text-white"
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
          ? 'rounded bg-white/10 px-1 py-0.5 text-xs'
          : 'block whitespace-pre-wrap rounded-lg bg-white/10 p-2 text-xs'
      }
    >
      {children}
    </code>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="mb-2 overflow-x-auto">{children}</pre>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-2 list-disc pl-5 text-neutral-200 text-sm">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-2 list-decimal pl-5 text-neutral-200 text-sm">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li className="mb-0.5">{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-white">{children}</strong>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mb-2 text-base font-semibold text-white">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mb-1.5 text-sm font-semibold text-white">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mb-1 text-sm font-semibold text-white">{children}</h3>
  )
}

// Memory card - full version for expanded view
function MemoryCardFull({
  memory,
  onClick
}: {
  memory: Memory
  onClick: () => void
}): React.JSX.Element {
  const formatTime = (dateStr: string): string => parseSqliteUtc(dateStr).toLocaleString()

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ scale: 1.01 }}
      onClick={onClick}
      className="group p-4 rounded-xl cursor-pointer transition-all bg-neutral-900/60 border border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/60"
    >
      <p className="text-sm text-neutral-200 leading-relaxed">{memory.content}</p>
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-neutral-800">
        <span className="text-[10px] text-neutral-500">{formatTime(memory.created_at)}</span>
        <span className="text-[10px] text-neutral-400 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          View in Memories
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </span>
      </div>
    </motion.div>
  )
}

// Compact memory card for bento view
function MemoryCard({
  memory,
  onClick
}: {
  memory: Memory
  onClick: () => void
}): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: 1.02 }}
      onClick={onClick}
      className="group p-3 rounded-xl cursor-pointer transition-all bg-neutral-900/60 border border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/60"
    >
      <p className="text-xs text-neutral-300 line-clamp-2 leading-relaxed">{memory.content}</p>
      <div className="flex items-center gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="text-[10px] text-neutral-400 flex items-center gap-1">
          View details
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </span>
      </div>
    </motion.div>
  )
}

// Entity card - full version for expanded view
function EntityCardFull({
  entity,
  onClick
}: {
  entity: Entity
  onClick: () => void
}): React.JSX.Element {
  const formatTime = (dateStr: string): string => parseSqliteUtc(dateStr).toLocaleString()

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ scale: 1.01 }}
      onClick={onClick}
      className="group p-4 rounded-xl cursor-pointer transition-all bg-neutral-900/60 border border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/60"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="font-semibold text-white">{entity.name}</span>
        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-neutral-800 text-neutral-400 border border-neutral-700">
          {entity.type || 'Unknown'}
        </span>
        <span className="px-2 py-0.5 text-[10px] rounded bg-neutral-800 text-neutral-400">
          {entity.fact_count} facts
        </span>
      </div>
      {entity.summary && (
        <p className="text-sm text-neutral-300 leading-relaxed">{entity.summary}</p>
      )}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-neutral-800">
        <span className="text-[10px] text-neutral-500">{formatTime(entity.updated_at)}</span>
        <span className="text-[10px] text-neutral-400 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          View Details
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </span>
      </div>
    </motion.div>
  )
}

// Compact entity card for bento view
function EntityCard({
  entity,
  onClick
}: {
  entity: Entity
  onClick: () => void
}): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: 1.02 }}
      onClick={onClick}
      className="group p-3 rounded-xl cursor-pointer transition-all bg-neutral-900/60 border border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/60"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm text-white truncate">{entity.name}</span>
        <span className="px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded bg-neutral-800 text-neutral-400">
          {entity.type || 'Unknown'}
        </span>
      </div>
      {entity.summary && (
        <p className="text-[11px] text-neutral-400 line-clamp-1 mt-1">{entity.summary}</p>
      )}
      <div className="flex items-center gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="text-[10px] text-neutral-400 flex items-center gap-1">
          {entity.fact_count} facts · View details
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </span>
      </div>
    </motion.div>
  )
}

// Section header with expand button
function SectionHeader({
  title,
  count,
  icon,
  colorClass,
  onExpand,
  isExpanded
}: {
  title: string
  count: number
  icon: React.ReactNode
  colorClass: string
  onExpand: () => void
  isExpanded?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center', colorClass)}>
        {icon}
      </div>
      <span className="text-sm font-medium text-white">{title}</span>
      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-neutral-700 text-neutral-300">
        {count}
      </span>
      <button
        onClick={onExpand}
        className="ml-auto p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-700/50 transition-colors"
        title={isExpanded ? 'Collapse' : 'Expand'}
      >
        {isExpanded ? (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
            />
          </svg>
        )}
      </button>
    </div>
  )
}

export function ChatDetail({
  sessionId,
  onBack,
  onSelectEntity,
  onSelectMemory
}: ChatDetailProps): React.JSX.Element {
  const [memories, setMemories] = useState<Memory[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [summary, setSummary] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expandedSection, setExpandedSection] = useState<ExpandedSection>(null)

  // Parse session ID to extract title + model (shared with ChatList).
  const { modelName, readableTitle, llmLabel } = parseSessionId(sessionId)

  // Keyboard shortcut for back navigation (Cmd+[) and Escape to collapse
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '[') {
        e.preventDefault()
        if (expandedSection) {
          setExpandedSection(null)
        } else {
          onBack()
        }
      }
      if (e.key === 'Escape' && expandedSection) {
        setExpandedSection(null)
      }
    },
    [onBack, expandedSection]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  useEffect(() => {
    const fetchData = async (): Promise<void> => {
      setLoading(true)
      try {
        const [memoriesData, entitiesData, sessionsData] = await Promise.all([
          window.api.getMemoryRecordsForSession(sessionId),
          window.api.getEntitiesForSession(sessionId),
          window.api.getChatSessions()
        ])
        setMemories(memoriesData)
        setEntities(entitiesData)

        const thisSession = sessionsData.find((session) => session.session_id === sessionId)
        setSummary(thisSession?.summary || null)
      } catch (e) {
        console.error('Failed to load session data', e)
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [sessionId])

  const handleExpand = (section: ExpandedSection): void => {
    setExpandedSection(expandedSection === section ? null : section)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Compact Header */}
      <div className="px-4 py-3 border-b border-neutral-800 bg-neutral-900/50 backdrop-blur-xl flex items-center gap-3">
        <button
          onClick={() => (expandedSection ? setExpandedSection(null) : onBack())}
          className="p-2 rounded-lg bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors"
          title={expandedSection ? 'Close (⌘[ or Esc)' : 'Back (⌘[)'}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="font-semibold text-white truncate text-sm">{readableTitle}</h1>
          {modelName && (
            <span className="text-[10px] text-neutral-500 uppercase tracking-wide">{llmLabel}</span>
          )}
        </div>
        {expandedSection && (
          <span className="px-2 py-1 rounded-lg bg-neutral-800 text-neutral-400 text-xs">
            {expandedSection.charAt(0).toUpperCase() + expandedSection.slice(1)} View
          </span>
        )}
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-16 flex-1">
          <div className="relative">
            <div className="w-10 h-10 border-2 border-neutral-700 rounded-full" />
            <div className="absolute top-0 left-0 w-10 h-10 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
          </div>
        </div>
      )}

      {/* Content */}
      {!loading && (
        <AnimatePresence mode="wait">
          {/* Expanded Summary View */}
          {expandedSection === 'summary' && (
            <motion.div
              key="expanded-summary"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 p-4 overflow-y-auto"
            >
              <div className="relative min-h-full rounded-2xl p-5 bg-neutral-900/60 border border-neutral-800">
                <BorderBeam
                  size={200}
                  duration={10}
                  borderWidth={1.5}
                  className="from-neutral-600/40 via-neutral-500/40 to-neutral-600/40"
                />

                <SectionHeader
                  title="Summary"
                  count={summary ? 1 : 0}
                  icon={
                    <svg
                      className="w-4 h-4 text-neutral-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                  }
                  colorClass="bg-neutral-800/60 border border-neutral-700"
                  onExpand={() => handleExpand('summary')}
                  isExpanded
                />
                <div className="relative z-10">
                  {summary ? (
                    <div className="text-base leading-relaxed">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkBreaks]}
                        components={markdownComponents}
                      >
                        {summary}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <p className="text-neutral-500">No summary available</p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/* Expanded Memories View */}
          {expandedSection === 'memories' && (
            <motion.div
              key="expanded-memories"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 p-4 overflow-hidden"
            >
              <div className="relative h-full rounded-2xl p-5 bg-neutral-900/60 border border-neutral-800 overflow-hidden flex flex-col">
                <BorderBeam
                  size={200}
                  duration={8}
                  borderWidth={1.5}
                  className="from-neutral-600/40 via-neutral-500/40 to-neutral-600/40"
                />

                <SectionHeader
                  title="Memories"
                  count={memories.length}
                  icon={
                    <svg
                      className="w-4 h-4 text-neutral-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                      />
                    </svg>
                  }
                  colorClass="bg-neutral-800/60 border border-neutral-700"
                  onExpand={() => handleExpand('memories')}
                  isExpanded
                />
                <div className="relative flex-1 min-h-0">
                  <div className="absolute inset-0 overflow-y-auto pr-2 pb-16">
                    {memories.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {memories.map((memory) => (
                          <MemoryCardFull
                            key={memory.id}
                            memory={memory}
                            onClick={() => onSelectMemory?.(memory.id)}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full text-center">
                        <p className="text-neutral-500">No memories yet</p>
                      </div>
                    )}
                  </div>
                  {memories.length > 4 && (
                    <ProgressiveBlur
                      height="60px"
                      position="bottom"
                      className="pointer-events-none"
                    />
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/* Expanded Entities View */}
          {expandedSection === 'entities' && (
            <motion.div
              key="expanded-entities"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 p-4 overflow-hidden"
            >
              <div className="relative h-full rounded-2xl p-5 bg-neutral-900/60 border border-neutral-800 overflow-hidden flex flex-col">
                <BorderBeam
                  size={200}
                  duration={8}
                  delay={2}
                  borderWidth={1.5}
                  className="from-neutral-600/40 via-neutral-500/40 to-neutral-600/40"
                />

                <SectionHeader
                  title="Entities"
                  count={entities.length}
                  icon={
                    <svg
                      className="w-4 h-4 text-neutral-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                      />
                    </svg>
                  }
                  colorClass="bg-neutral-800/60 border border-neutral-700"
                  onExpand={() => handleExpand('entities')}
                  isExpanded
                />
                <div className="relative flex-1 min-h-0">
                  <div className="absolute inset-0 overflow-y-auto pr-2 pb-16">
                    {entities.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {entities.map((entity) => (
                          <EntityCardFull
                            key={entity.id}
                            entity={entity}
                            onClick={() => onSelectEntity?.(entity.id)}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full text-center">
                        <p className="text-neutral-500">No entities yet</p>
                      </div>
                    )}
                  </div>
                  {entities.length > 4 && (
                    <ProgressiveBlur
                      height="60px"
                      position="bottom"
                      className="pointer-events-none"
                    />
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/* Bento Grid Layout - Default View */}
          {!expandedSection && (
            <motion.div
              key="bento-grid"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 p-4 flex flex-col gap-4 overflow-hidden"
            >
              {/* Row 1: Summary - Takes ~50% */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="relative flex-[2] min-h-0 rounded-2xl p-4 bg-neutral-900/60 border border-neutral-800 overflow-hidden cursor-pointer hover:border-neutral-700 transition-colors"
                onClick={() => handleExpand('summary')}
              >
                <BorderBeam
                  size={150}
                  duration={10}
                  borderWidth={1}
                  className="from-neutral-600/30 via-neutral-500/30 to-neutral-600/30"
                />

                <div className="relative z-10 h-full flex flex-col">
                  <SectionHeader
                    title="Summary"
                    count={summary ? 1 : 0}
                    icon={
                      <svg
                        className="w-3.5 h-3.5 text-neutral-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                    }
                    colorClass="bg-neutral-800/60 border border-neutral-700"
                    onExpand={() => handleExpand('summary')}
                  />
                  <div className="flex-1 overflow-y-auto pr-2">
                    {summary ? (
                      <div>
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkBreaks]}
                          components={markdownComponents}
                        >
                          {summary}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full text-center">
                        <p className="text-neutral-500 text-sm">No summary available</p>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>

              {/* Row 2: Memories & Entities side by side - Takes ~50% */}
              <div className="flex-1 min-h-0 grid grid-cols-2 gap-4">
                {/* Memories Section */}
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.1 }}
                  className="relative rounded-2xl p-4 bg-neutral-900/60 border border-neutral-800 overflow-hidden flex flex-col cursor-pointer hover:border-neutral-700 transition-colors"
                  onClick={() => handleExpand('memories')}
                >
                  <BorderBeam
                    size={100}
                    duration={8}
                    borderWidth={1}
                    className="from-neutral-600/30 via-neutral-500/30 to-neutral-600/30"
                  />

                  <div className="relative z-10 flex flex-col h-full">
                    <SectionHeader
                      title="Memories"
                      count={memories.length}
                      icon={
                        <svg
                          className="w-3.5 h-3.5 text-neutral-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                          />
                        </svg>
                      }
                      colorClass="bg-neutral-800/60 border border-neutral-700"
                      onExpand={() => handleExpand('memories')}
                    />
                    <div className="flex-1 overflow-hidden space-y-2">
                      {memories.length > 0 ? (
                        memories
                          .slice(0, 3)
                          .map((memory) => (
                            <MemoryCard
                              key={memory.id}
                              memory={memory}
                              onClick={() => onSelectMemory?.(memory.id)}
                            />
                          ))
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full text-center py-4">
                          <p className="text-neutral-500 text-xs">No memories yet</p>
                        </div>
                      )}
                      {memories.length > 3 && (
                        <p className="text-[10px] text-neutral-500 text-center">
                          +{memories.length - 3} more
                        </p>
                      )}
                    </div>
                  </div>
                </motion.div>

                {/* Entities Section */}
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.15 }}
                  className="relative rounded-2xl p-4 bg-neutral-900/60 border border-neutral-800 overflow-hidden flex flex-col cursor-pointer hover:border-neutral-700 transition-colors"
                  onClick={() => handleExpand('entities')}
                >
                  <BorderBeam
                    size={100}
                    duration={8}
                    delay={2}
                    borderWidth={1}
                    className="from-neutral-600/30 via-neutral-500/30 to-neutral-600/30"
                  />

                  <div className="relative z-10 flex flex-col h-full">
                    <SectionHeader
                      title="Entities"
                      count={entities.length}
                      icon={
                        <svg
                          className="w-3.5 h-3.5 text-neutral-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                          />
                        </svg>
                      }
                      colorClass="bg-neutral-800/60 border border-neutral-700"
                      onExpand={() => handleExpand('entities')}
                    />
                    <div className="flex-1 overflow-hidden space-y-2">
                      {entities.length > 0 ? (
                        entities
                          .slice(0, 3)
                          .map((entity) => (
                            <EntityCard
                              key={entity.id}
                              entity={entity}
                              onClick={() => onSelectEntity?.(entity.id)}
                            />
                          ))
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full text-center py-4">
                          <p className="text-neutral-500 text-xs">No entities yet</p>
                        </div>
                      )}
                      {entities.length > 3 && (
                        <p className="text-[10px] text-neutral-500 text-center">
                          +{entities.length - 3} more
                        </p>
                      )}
                    </div>
                  </div>
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  )
}
