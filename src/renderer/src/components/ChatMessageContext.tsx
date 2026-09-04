/**
 * The retrieved-context disclosure under an assistant turn: the sources, memories, summaries,
 * entities and facts that grounded the answer, and where each one opens.
 */
import { preprocessChatMarkdown } from '@offgrid/application'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { type RagContext, type RagEntity, type RagEntityFact, type RagMemory, type RagSummary } from '@renderer/lib/chat-transcript-types'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { captureUrlForPath } from '../../../shared/ogcapture-url'
import { contextResultCount, markdownComponents, openUnifiedContext, type ContextNavigation, type UnifiedContextItem } from './chat-message-projection'

function UnifiedContextSection({
  items,
  navigation
}: Readonly<{
  items?: readonly UnifiedContextItem[]
  navigation: ContextNavigation
}>): React.JSX.Element | null {
  if (!items?.length) return null
  return (
    <div className="mb-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Sources ({items.length}) — cited as [S#]
      </div>
      <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-3">
        {items.map((item, index) => {
          const title = item.title && item.title !== item.surface ? item.title : item.snippet
          const replaySuffix = item.kind === 'screen' ? ' · open in Replay →' : ''
          return (
            <button
              key={`${item.kind}-${item.refId ?? item.ts}-${index}`}
              type="button"
              onClick={() => openUnifiedContext(item, navigation)}
              title={`${item.kind} · ${item.surface}${item.title ? ` · ${item.title}` : ''}${replaySuffix}`}
              className="flex flex-col gap-1 overflow-hidden rounded-md border border-neutral-800 p-2 text-left text-[11px] text-neutral-400 transition-colors hover:border-green-500"
            >
              {item.kind === 'screen' && item.imagePath ? (
                <img
                  src={captureUrlForPath(item.imagePath)}
                  alt=""
                  className="mb-0.5 h-16 w-full rounded border border-neutral-800 object-cover"
                />
              ) : null}
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-green-500">[S{index + 1}]</span>
                <span className="rounded-sm border border-neutral-700 px-1 text-[9px] uppercase tracking-wide text-neutral-500">
                  {item.kind}
                </span>
              </div>
              <span className="line-clamp-2 text-neutral-300">{title}</span>
              <span className="truncate text-[10px] text-neutral-600">
                {item.surface}
                {replaySuffix}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SourceScoresSection({
  sources
}: Readonly<{
  sources?: readonly NonNullable<RagContext['sources']>[number][]
}>): React.JSX.Element | null {
  if (!sources?.length) return null
  return (
    <div className="mb-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Sources ({sources.length})
      </div>
      <div className="space-y-1">
        {sources.slice(0, 8).map((source, index) => (
          <div
            key={`${source.name}-${index}`}
            className="flex items-center gap-2 rounded-md border border-neutral-800 p-2 text-[11px] text-neutral-400"
          >
            <span className="min-w-0 flex-1 truncate">{source.name}</span>
            <span className="shrink-0 text-neutral-600">{(source.score * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MasterMemorySection({
  content
}: Readonly<{ content?: string | null }>): React.JSX.Element | null {
  if (!content) return null
  return (
    <div className="mb-3 rounded-md border border-neutral-800 p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">Master memory</div>
      <div className="text-neutral-300">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
          {preprocessChatMarkdown(content)}
        </ReactMarkdown>
      </div>
    </div>
  )
}

function MemoriesContextSection({
  memories,
  onNavigate
}: Readonly<{
  memories?: readonly RagMemory[]
  onNavigate?: (memoryId: number) => void
}>): React.JSX.Element | null {
  if (!memories?.length) return null
  return (
    <div className="mb-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Memories ({memories.length})
      </div>
      <div className="space-y-1">
        {memories.slice(0, 5).map((memory, index) => (
          <button
            key={memory.id || index}
            type="button"
            onClick={() => onNavigate?.(memory.id)}
            className="block w-full rounded-md border border-neutral-800 p-2 text-left transition-colors hover:border-neutral-700"
          >
            <p className="line-clamp-2 text-[11px] text-neutral-400">
              {memory.content || memory.text || 'Memory'}
            </p>
          </button>
        ))}
      </div>
    </div>
  )
}

function SummariesContextSection({
  summaries,
  onNavigate
}: Readonly<{
  summaries?: readonly RagSummary[]
  onNavigate?: (sessionId: string) => void
}>): React.JSX.Element | null {
  if (!summaries?.length) return null
  return (
    <div className="mb-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Related chats ({summaries.length})
      </div>
      <div className="space-y-1">
        {summaries.slice(0, 5).map((summary, index) => (
          <button
            key={summary.session_id || index}
            type="button"
            onClick={() => onNavigate?.(summary.session_id)}
            className="block w-full rounded-md border border-neutral-800 p-2 text-left transition-colors hover:border-neutral-700"
          >
            <p className="line-clamp-2 text-[11px] text-neutral-400">
              {summary.summary || summary.title || 'Chat'}
            </p>
            {summary.app_name ? (
              <span className="mt-1 inline-block text-[10px] text-neutral-600">
                {summary.app_name}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}

function EntitiesContextSection({
  entities,
  onNavigate
}: Readonly<{
  entities?: readonly RagEntity[]
  onNavigate?: (entityId: number) => void
}>): React.JSX.Element | null {
  if (!entities?.length) return null
  return (
    <div className="mb-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Entities ({entities.length})
      </div>
      <div className="flex flex-wrap gap-1">
        {entities.slice(0, 10).map((entity, index) => (
          <button
            key={entity.id || index}
            type="button"
            onClick={() => onNavigate?.(entity.id)}
            className="rounded-md border border-neutral-800 px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-green-500 hover:text-green-500"
          >
            {entity.name || 'Entity'}
          </button>
        ))}
      </div>
    </div>
  )
}

function EntityFactsContextSection({
  facts
}: Readonly<{ facts?: readonly RagEntityFact[] }>): React.JSX.Element | null {
  if (!facts?.length) return null
  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Entity facts ({facts.length})
      </div>
      <div className="space-y-1">
        {facts.slice(0, 5).map((fact, index) => (
          <div key={index} className="rounded-md border border-neutral-800 p-2">
            <p className="line-clamp-2 text-[11px] text-neutral-400">
              {typeof fact === 'string' ? fact : fact.fact}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ContextDisclosure({
  context,
  navigation
}: Readonly<{
  context?: RagContext
  navigation: ContextNavigation
}>): React.JSX.Element | null {
  if (!context) return null
  const resultCount = contextResultCount(context)
  if (resultCount === 0) return null
  return (
    <Collapsible className="mt-2 w-full max-w-[90%]">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-left text-xs text-neutral-400 transition-colors hover:border-neutral-700">
        <svg
          className="h-3.5 w-3.5 text-green-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span className="flex-1">Searched your memory — {resultCount} results</span>
        <svg
          className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 max-h-[400px] max-w-full overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900/40 p-4 text-sm">
        <UnifiedContextSection items={context.unified} navigation={navigation} />
        <SourceScoresSection sources={context.sources} />
        <MasterMemorySection content={context.masterMemory} />
        <MemoriesContextSection
          memories={context.memories}
          onNavigate={navigation.onNavigateToMemory}
        />
        <SummariesContextSection
          summaries={context.summaries}
          onNavigate={navigation.onNavigateToChat}
        />
        <EntitiesContextSection
          entities={context.entities}
          onNavigate={navigation.onNavigateToEntity}
        />
        <EntityFactsContextSection facts={context.entityFacts} />
      </CollapsibleContent>
    </Collapsible>
  )
}

