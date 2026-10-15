import { memo } from 'react'
import { navigateSearchHit } from '@renderer/lib/search-navigation'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import { captureUrlForPath } from '../../../../../shared/ogcapture-url'
import type {
  ChatMessage,
  ContextNavigation,
  RagContext,
  RagEntity,
  RagSummary,
  UnifiedContextItem
} from '../types'
import { contextResultCount } from '../utlis'

export function hasInlineMemorySources(
  message: ChatMessage
): message is ChatMessage & { context: RagContext & { unified: UnifiedContextItem[] } } {
  return Boolean(
    message.role === 'assistant' &&
    message.context?.unified?.length &&
    message.toolCalls?.some(
      (tool) =>
        tool.name === 'search_memory' &&
        tool.status !== 'failed' &&
        !/^\s*(error|failed)\s*:/i.test(tool.result)
    )
  )
}

export function openUnifiedContext(item: UnifiedContextItem, navigation: ContextNavigation): void {
  if (item.kind === 'attachment' && typeof item.key === 'string') {
    // key: attachment:<documentId>:<page>:<position>
    const [, documentId, page] = item.key.split(':')
    if (documentId) navigation.onOpenDocument?.(documentId, Number(page) || 1)
    return
  }
  navigateSearchHit(
    {
      ...item,
      key: item.key ?? `${item.kind}:${String(item.refId ?? item.ts)}`,
      refId: item.refId ?? 0,
      url: item.url ?? null,
      score: item.score ?? 0,
      imagePath: item.imagePath ?? null
    },
    {
      selectEntity: (entityId) => navigation.onNavigateToEntity?.(entityId),
      openMeeting: (meetingId) => {
        if (meetingId != null) navigation.onNavigateToMeeting?.(meetingId)
      },
      openChat: (target) => {
        if (target?.conversationId) navigation.onNavigateToChat?.(target.conversationId)
        if (target?.projectId) navigation.onOpenProject?.(target.projectId)
      },
      openReplay: (timestamp) => navigation.onSeekReplay?.(timestamp),
      openAction: (actionId) => navigation.onNavigateToAction?.(actionId)
    }
  )
}

function UnifiedContextSectionComponent({
  items,
  navigation
}: Readonly<{
  items?: readonly UnifiedContextItem[]
  navigation: ContextNavigation
}>): React.JSX.Element | null {
  if (!items?.length) return null
  // Document passages: thin rows grouped by document. Other sources keep their cards. The tag stays
  // the source's place in the full list, so it matches the [S#] in the answer.
  const indexed = items.map((item, index) => ({ item, index }))
  const documentGroups = new Map<string, { item: UnifiedContextItem; index: number }[]>()
  for (const entry of indexed) {
    if (entry.item.kind !== 'attachment') continue
    const group = documentGroups.get(entry.item.surface) ?? []
    group.push(entry)
    documentGroups.set(entry.item.surface, group)
  }
  const others = indexed.filter((entry) => entry.item.kind !== 'attachment')
  return (
    <div className="mb-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Sources ({items.length}) — cited as [S#]
      </div>
      {[...documentGroups].map(([name, group]) => (
        <div key={name} className="mb-2 overflow-hidden rounded-md border border-neutral-800">
          <div className="truncate border-b border-neutral-800 px-2 py-1 text-[11px] font-medium text-neutral-300">
            {name}
          </div>
          <ul className="divide-y divide-neutral-800/70">
            {group.map(({ item, index }) => (
              <li key={item.key ?? index}>
                <button
                  type="button"
                  onClick={() => openUnifiedContext(item, navigation)}
                  className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-[11px] text-neutral-400 transition-colors hover:bg-green-500/5 hover:text-neutral-200"
                >
                  <span className="shrink-0 font-semibold text-green-500">[S{index + 1}]</span>
                  <span className="shrink-0 text-neutral-500">
                    {item.title.split(' · ').at(-1)}
                  </span>
                  <span className="min-w-0 truncate">{item.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {others.length ? (
        <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-3">
          {others.map(({ item, index }) => {
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
                    loading="lazy"
                    decoding="async"
                    fetchPriority="low"
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
      ) : null}
    </div>
  )
}

function SourceScoresSectionComponent({
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
      <div className="overflow-hidden rounded-md border border-neutral-800 divide-y divide-neutral-900">
        {sources.slice(0, 8).map((source, index) => (
          <div
            key={`${source.name}-${index}`}
            className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-neutral-400"
          >
            <span className="min-w-0 flex-1 truncate">{source.name}</span>
            <span className="shrink-0 text-neutral-600">{(source.score * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function SummariesContextSectionComponent({
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
      <div className="overflow-hidden rounded-md border border-neutral-800 divide-y divide-neutral-900">
        {summaries.slice(0, 5).map((summary, index) => (
          <button
            key={summary.session_id || index}
            type="button"
            onClick={() => onNavigate?.(summary.session_id)}
            className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-neutral-900/60"
          >
            <span className="line-clamp-2 min-w-0 flex-1 text-[11px] text-neutral-400">
              {summary.summary || summary.title || 'Chat'}
            </span>
            {summary.app_name ? (
              <span className="shrink-0 text-[10px] text-neutral-600">{summary.app_name}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}

function EntitiesContextSectionComponent({
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

function ContextDisclosureComponent({
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
        <SummariesContextSection
          summaries={context.summaries}
          onNavigate={navigation.onNavigateToChat}
        />
        <EntitiesContextSection
          entities={context.entities}
          onNavigate={navigation.onNavigateToEntity}
        />
      </CollapsibleContent>
    </Collapsible>
  )
}

export const UnifiedContextSection = memo(UnifiedContextSectionComponent)
const SourceScoresSection = memo(SourceScoresSectionComponent)
const SummariesContextSection = memo(SummariesContextSectionComponent)
const EntitiesContextSection = memo(EntitiesContextSectionComponent)
export const ContextDisclosure = memo(ContextDisclosureComponent)
