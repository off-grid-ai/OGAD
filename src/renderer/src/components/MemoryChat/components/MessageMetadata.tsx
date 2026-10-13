import { memo } from 'react'
import { CaretDown, Pulse, WarningCircle, Wrench } from '@phosphor-icons/react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import { resolveModelName } from '@renderer/lib/model-summary'
import { formatGenerationMetrics, type GenerationMetrics } from '../../../../../shared/generation-metrics'
import type { ResponseCutoffContract } from '../../../../../shared/ipc-contracts'
import type { ChatMessage } from '../types'

function GenerationMetricsRowComponent({
  metrics,
  videoMetadata,
  generationTimeMs,
  open,
  onOpenChange
}: Readonly<{
  metrics?: GenerationMetrics
  videoMetadata?: ChatMessage['videoMetadata']
  generationTimeMs?: number
  open: boolean
  onOpenChange: (open: boolean) => void
}>): React.JSX.Element | null {
  console.log('MemoryChat GenerationMetricsRow rendered')
  const availableMetrics = metrics ?? (videoMetadata ? {
    modelName: videoMetadata.model,
    totalSeconds: generationTimeMs === undefined ? undefined : generationTimeMs / 1000
  } : undefined)
  const displayMetrics = availableMetrics?.modelName
    ? { ...availableMetrics, modelName: resolveModelName([], availableMetrics.modelName) ?? availableMetrics.modelName }
    : availableMetrics
  const parts = [
    ...(videoMetadata ? [
      `${videoMetadata.width} × ${videoMetadata.height}`,
      `${videoMetadata.durationSeconds}s video`,
      `${videoMetadata.fps} fps`,
      `${videoMetadata.frames} frames`
    ] : []),
    ...(displayMetrics ? formatGenerationMetrics(displayMetrics) : [])
  ]
  const contextWindowTokens = metrics?.contextWindowTokens
  const promptTokens = metrics?.promptTokens ?? metrics?.estimatedPromptTokens
  const estimated =
    metrics?.promptTokens === undefined && metrics?.estimatedPromptTokens !== undefined
  const contextPercent =
    promptTokens && contextWindowTokens && contextWindowTokens > 0
      ? Math.round((promptTokens / contextWindowTokens) * 100)
      : null
  const contextLabel =
    contextPercent !== null
      ? `Context: ${estimated ? '~' : ''}${contextPercent}% used (${estimated ? '~' : ''}${promptTokens} prompt tokens / ${contextWindowTokens} context)`
      : promptTokens
        ? `Context: ${estimated ? '~' : ''}${promptTokens} tokens used (limit unknown)`
        : null
  if (!parts.length && contextLabel === null) return null
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="contents">
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-left font-mono text-[10px] text-neutral-500 transition-colors hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-500">
        <Pulse className="h-3 w-3" aria-hidden="true" />
        <span>Generation details</span>
        <CaretDown
          className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="order-last min-w-0 max-w-full basis-full overflow-hidden font-mono text-[10px] text-neutral-500">
        <p
          className="ml-1 mt-1 border-l border-neutral-800 pl-3 tabular-nums [overflow-wrap:anywhere]"
          data-testid="generation-metrics"
        >
          {[...(contextLabel === null ? [] : [contextLabel]), ...parts].join(' · ')}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolsSentDisclosureComponent({
  names,
  open,
  onOpenChange
}: Readonly<{
  names?: readonly string[]
  open: boolean
  onOpenChange: (open: boolean) => void
}>): React.JSX.Element | null {
  console.log('MemoryChat ToolsSentDisclosure rendered')
  if (!names?.length) return null
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="contents">
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-left text-[10px] text-neutral-500 transition-colors hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-500">
        <Wrench className="h-3 w-3" aria-hidden="true" />
        <span>Tools sent in request ({names.length})</span>
        <CaretDown
          className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="order-last max-w-full basis-full text-[10px] text-neutral-500">
        <ul className="ml-1 mt-1 max-h-56 space-y-0.5 overflow-y-auto border-l border-neutral-800 pl-3">
          {names.map((name, index) => (
            <li key={`${name}:${index}`}>{name}</li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ResponseCutoffNoticeComponent({
  cutoff
}: Readonly<{ cutoff?: ResponseCutoffContract }>): React.JSX.Element | null {
  console.log('MemoryChat ResponseCutoffNotice rendered')
  if (!cutoff) return null
  return (
    <p
      role="status"
      className="mt-2 flex items-start gap-1.5 border-t border-amber-500/20 pt-2 text-[11px] text-amber-400"
    >
      <WarningCircle className="mt-0.5 h-3 w-3 shrink-0" weight="fill" />
      Response stopped at the configured {cutoff.maxTokens.toLocaleString()}-token limit.
    </p>
  )
}

export const GenerationMetricsRow = memo(GenerationMetricsRowComponent)
export const ToolsSentDisclosure = memo(ToolsSentDisclosureComponent)
export const ResponseCutoffNotice = memo(ResponseCutoffNoticeComponent)
