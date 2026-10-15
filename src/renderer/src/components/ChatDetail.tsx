import { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Empty, EmptyDescription } from '@offgrid/operator-ui/operator/coss/empty'
import { Skeleton } from '@offgrid/operator-ui/operator/coss/skeleton'
import { AnimatedNumber } from '@offgrid/operator-ui/operator/motion/animated-number'
import { PageHeader, Section } from '@offgrid/operator-ui/operator/experience'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { parseSqliteUtc } from '@renderer/lib/time'
import { parseSessionId } from '@renderer/lib/session-id'
import { BorderBeam } from './ui/border-beam'
import { ProgressiveBlur } from './ui/progressive-blur'
import { openChatLink } from '@renderer/lib/chat-link'
import { primaryModifier } from '@renderer/lib/device'

interface Entity {
  id: number
  name: string
  type: string
  summary: string | null
  updated_at: string
}

interface ChatDetailProps {
  sessionId: string
  onBack: () => void
  onSelectEntity?: (entityId: number) => void
}

type ExpandedSection = 'summary' | 'entities' | null

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

// Entity card - full version for expanded view
function EntityCardFull({ entity, onClick }: { entity: Entity; onClick: () => void }): React.JSX.Element {
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
function EntityCard({ entity, onClick }: { entity: Entity; onClick: () => void }): React.JSX.Element {
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
          View details
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </span>
      </div>
    </motion.div>
  )
}

// A section's count and its expand/collapse control, in the Section's actions slot.
function SectionActions({
  count,
  onExpand,
  isExpanded
}: {
  count: number
  onExpand: () => void
  isExpanded?: boolean
}): React.JSX.Element {
  return (
    <>
      <AnimatedNumber
        value={count}
        className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-neutral-700 text-neutral-300"
      />
      <button
        onClick={onExpand}
        className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-700/50 transition-colors"
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
    </>
  )
}


export function ChatDetail({ sessionId, onBack, onSelectEntity }: ChatDetailProps): React.JSX.Element {
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
        const [entitiesData, sessionsData] = await Promise.all([
          window.api.getEntitiesForSession(sessionId),
          window.api.getChatSessions()
        ])
        setEntities(entitiesData)

        const thisSession = sessionsData.find((s) => s.session_id === sessionId)
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
      <div className="px-6 pt-5">
        <button
          onClick={() => (expandedSection ? setExpandedSection(null) : onBack())}
          className="mb-4 p-2 rounded-lg bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors"
          title={expandedSection ? `Close (${primaryModifier()}+[ or Esc)` : `Back (${primaryModifier()}+[)`}
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
        <PageHeader
          title={readableTitle}
          eyebrow={modelName ? llmLabel : undefined}
          actions={
            expandedSection ? (
              <span className="px-2 py-1 rounded-lg bg-neutral-800 text-neutral-400 text-xs">
                {expandedSection.charAt(0).toUpperCase() + expandedSection.slice(1)} View
              </span>
            ) : undefined
          }
          className="pb-6 [&>div:first-child]:max-w-full [&_h1]:truncate"
        />
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex-1 px-6 pb-6 space-y-12 overflow-hidden" aria-busy="true">
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
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
              className="flex-1 px-6 pb-6 overflow-y-auto"
            >
              <div className="relative min-h-full rounded-2xl p-5 bg-neutral-900/60 border border-neutral-800">
                <BorderBeam
                  size={200}
                  duration={10}
                  borderWidth={1.5}
                  className="from-neutral-600/40 via-neutral-500/40 to-neutral-600/40"
                />
                <Section
                  label="Summary"
                  actions={
                    <SectionActions
                      count={summary ? 1 : 0}
                      onExpand={() => handleExpand('summary')}
                      isExpanded
                    />
                  }
                  className="relative z-10"
                >
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
                    <Empty className="flex-none gap-0 px-0 py-16 md:py-16">
                      <EmptyDescription className="text-neutral-500 text-[length:inherit]">
                        No summary available
                      </EmptyDescription>
                    </Empty>
                  )}
                </Section>
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
              className="flex-1 px-6 pb-6 overflow-hidden"
            >
              <div className="relative h-full rounded-2xl p-5 bg-neutral-900/60 border border-neutral-800 overflow-hidden">
                <BorderBeam
                  size={200}
                  duration={8}
                  delay={2}
                  borderWidth={1.5}
                  className="from-neutral-600/40 via-neutral-500/40 to-neutral-600/40"
                />
                <Section
                  label="Entities"
                  actions={
                    <SectionActions
                      count={entities.length}
                      onExpand={() => handleExpand('entities')}
                      isExpanded
                    />
                  }
                  className="relative z-10 flex h-full flex-col"
                >
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
                        <Empty className="h-full flex-none gap-0 px-0 py-0 md:py-0">
                          <EmptyDescription className="text-neutral-500 text-[length:inherit]">
                            No entities yet
                          </EmptyDescription>
                        </Empty>
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
                </Section>
              </div>
            </motion.div>
          )}

          {/* Default view: one section per idea, stacked with room between them */}
          {!expandedSection && (
            <motion.div
              key="bento-grid"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 px-6 pb-6 space-y-12 overflow-y-auto"
            >
              <Section
                label="Summary"
                actions={
                  <SectionActions
                    count={summary ? 1 : 0}
                    onExpand={() => handleExpand('summary')}
                  />
                }
              >
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Expand summary"
                  className="relative rounded-2xl p-4 bg-neutral-900/60 border border-neutral-800 overflow-hidden cursor-pointer hover:border-neutral-700 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-500"
                  onClick={() => handleExpand('summary')}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      handleExpand('summary')
                    }
                  }}
                >
                  <BorderBeam
                    size={150}
                    duration={10}
                    borderWidth={1}
                    className="from-neutral-600/30 via-neutral-500/30 to-neutral-600/30"
                  />
                  <div className="relative z-10 max-h-72 overflow-y-auto pr-2">
                    {summary ? (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkBreaks]}
                        components={markdownComponents}
                      >
                        {summary}
                      </ReactMarkdown>
                    ) : (
                      <Empty className="flex-none gap-0 px-0 py-4 md:py-4">
                        <EmptyDescription className="text-neutral-500 text-sm">
                          No summary available
                        </EmptyDescription>
                      </Empty>
                    )}
                  </div>
                </div>
              </Section>

              <Section
                label="Entities"
                actions={
                  <SectionActions
                    count={entities.length}
                    onExpand={() => handleExpand('entities')}
                  />
                }
              >
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Expand entities"
                  className="relative rounded-2xl p-4 bg-neutral-900/60 border border-neutral-800 overflow-hidden cursor-pointer hover:border-neutral-700 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-500"
                  onClick={() => handleExpand('entities')}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      handleExpand('entities')
                    }
                  }}
                >
                  <BorderBeam
                    size={100}
                    duration={8}
                    delay={2}
                    borderWidth={1}
                    className="from-neutral-600/30 via-neutral-500/30 to-neutral-600/30"
                  />
                  <div className="relative z-10 space-y-2">
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
                      <Empty className="flex-none gap-0 px-0 py-4 md:py-4">
                        <EmptyDescription className="text-neutral-500 text-xs">
                          No entities yet
                        </EmptyDescription>
                      </Empty>
                    )}
                    {entities.length > 3 && (
                      <p className="text-[10px] text-neutral-500 text-center">
                        +{entities.length - 3} more
                      </p>
                    )}
                  </div>
                </div>
              </Section>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  )
}
