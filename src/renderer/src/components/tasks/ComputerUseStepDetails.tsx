import { CaretDown } from '@phosphor-icons/react'
import { captureUrlForPath } from '../../../../shared/ogcapture-url'
import type { ComputerUseStepDetail } from '@renderer/lib/task-session-store'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'

function dimensions(detail: ComputerUseStepDetail): string | null {
  const frame = detail.screenshot
  if (!frame) return null
  return `${frame.originalWidth} × ${frame.originalHeight} source · ${frame.inferenceWidth} × ${frame.inferenceHeight} model input`
}

function tokenSummary(detail: ComputerUseStepDetail): string | null {
  const usage = detail.tokenUsage
  if (!usage) return null
  return [
    usage.input !== undefined ? `${usage.input} input` : null,
    usage.output !== undefined ? `${usage.output} output` : null,
    usage.context !== undefined ? `${usage.context} context` : null
  ]
    .filter(Boolean)
    .join(' · ')
}

function DetailBlock({ label, value }: Readonly<{ label: string; value?: string }>): React.JSX.Element | null {
  if (!value) return null
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wide text-neutral-600">{label}</p>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-neutral-400">
        {value}
      </pre>
    </div>
  )
}

export function ComputerUseStepDetails({
  details
}: Readonly<{ details: readonly ComputerUseStepDetail[] | undefined }>): React.JSX.Element | null {
  if (!details?.length) return null
  return (
    <div className="mt-2 space-y-1 border-t border-neutral-800 pt-2">
      <p className="text-[9px] uppercase tracking-wide text-neutral-600">Computer Use details</p>
      {details.map((detail, index) => {
        const timing = detail.execution?.durationMs
        const tokens = tokenSummary(detail)
        return (
          <Collapsible key={`${detail.stepId}:${detail.at}:${index}`}>
            <CollapsibleTrigger className="group flex w-full items-center gap-2 py-1 text-left text-[10px] text-neutral-400 hover:text-neutral-200">
              <span className="min-w-0 flex-1 truncate">
                {index + 1}. {detail.mappedAction || detail.execution?.result || detail.stepId}
              </span>
              <span className={detail.execution?.status === 'failed' ? 'text-red-500' : 'text-neutral-600'}>
                {timing !== undefined ? `${Math.round(timing)} ms · ` : ''}
                {detail.execution?.status ?? 'recorded'}
              </span>
              <CaretDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 border-l border-neutral-800 py-2 pl-3">
              {detail.screenshot?.path ? (
                <img
                  src={captureUrlForPath(detail.screenshot.path)}
                  alt={`Computer Use step ${index + 1}`}
                  className="max-h-40 w-full object-contain"
                />
              ) : null}
              {dimensions(detail) ? <p className="text-[10px] text-neutral-600">{dimensions(detail)}</p> : null}
              {tokens ? <p className="text-[10px] text-neutral-600">Tokens: {tokens}</p> : null}
              <DetailBlock label="Model input" value={detail.modelInput} />
              <DetailBlock label="Retrieved facts" value={detail.retrievedFacts?.join('\n')} />
              <DetailBlock label="Model response" value={detail.rawResponse} />
              <DetailBlock label="Mapped action" value={detail.mappedAction} />
              <DetailBlock label="Execution result" value={detail.execution?.result} />
              <DetailBlock label="Error" value={detail.execution?.error} />
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}
