import { useState } from 'react'
import { CaretDown } from '@phosphor-icons/react'
import { captureUrlForPath } from '../../../../shared/ogcapture-url'
import type { ComputerUseStepDetail } from '@renderer/lib/task-session-store'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import { ImageLightbox } from '@renderer/components/media/ImageLightbox'

function dimensions(detail: ComputerUseStepDetail): string | null {
  const frame = detail.screenshot
  if (!frame) return null
  return `${frame.originalWidth} x ${frame.originalHeight} source | ${frame.inferenceWidth} x ${frame.inferenceHeight} model input`
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
    .join(' | ')
}

function DetailBlock({
  label,
  value
}: Readonly<{ label: string; value?: string }>): React.JSX.Element | null {
  if (!value) return null
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
        {value}
      </pre>
    </div>
  )
}

export function ComputerUseStepDetails({
  details,
  showScreenshots = true
}: Readonly<{
  details: readonly ComputerUseStepDetail[] | undefined
  showScreenshots?: boolean
}>): React.JSX.Element | null {
  const [selectedScreenshot, setSelectedScreenshot] = useState<{ url: string; alt: string } | null>(
    null
  )
  if (!details?.length) return null
  return (
    <>
      <div className="mt-2 space-y-1 border-t border-border pt-2">
        <p className="text-[9px] uppercase tracking-wide text-muted-foreground">
          Computer Use details
        </p>
        {details.map((detail, index) => {
          const timing = detail.execution?.durationMs
          const tokens = tokenSummary(detail)
          const screenshotIsLocal =
            Boolean(detail.screenshot?.path) && detail.screenshot?.availability !== 'unavailable'
          const deviceName = detail.screenshot?.executionDeviceName
          const stepSummary =
            detail.decisionSummary ||
            detail.mappedAction ||
            detail.execution?.result ||
            detail.stepId
          return (
            <Collapsible key={`${detail.stepId}:${detail.at}:${index}`}>
              <CollapsibleTrigger
                className="group flex w-full items-center gap-2 py-1 text-left text-[10px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
                aria-label={`Computer Use step ${index + 1}: ${stepSummary}, ${detail.phase ?? detail.execution?.status ?? 'recorded'}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  Step {index + 1} | {stepSummary}
                </span>
                <span
                  className={
                    detail.execution?.status === 'failed' ? 'text-red-500' : 'text-muted-foreground'
                  }
                >
                  {timing !== undefined ? `${Math.round(timing)} ms | ` : ''}
                  {detail.phase ?? detail.execution?.status ?? 'recorded'}
                </span>
                <CaretDown
                  className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 border-l border-border py-2 pl-3">
                {showScreenshots && screenshotIsLocal && detail.screenshot?.path ? (
                  <button
                    type="button"
                    className="block w-full cursor-zoom-in focus:outline-none focus:ring-1 focus:ring-green-500"
                    aria-label={`Open full-screen screenshot for Computer Use step ${index + 1}`}
                    onClick={() =>
                      setSelectedScreenshot({
                        url: captureUrlForPath(detail.screenshot!.path!),
                        alt: `Computer Use step ${index + 1}`
                      })
                    }
                  >
                    <img
                      src={captureUrlForPath(detail.screenshot.path)}
                      alt={`Computer Use step ${index + 1}`}
                      className="max-h-40 w-full object-contain"
                    />
                  </button>
                ) : showScreenshots && detail.screenshot ? (
                  <p className="border border-border px-2 py-1.5 text-[10px] text-muted-foreground">
                    Screenshot stays on {deviceName || 'the execution device'}.
                  </p>
                ) : null}
                {dimensions(detail) ? (
                  <p className="text-[10px] text-muted-foreground">{dimensions(detail)}</p>
                ) : null}
                {tokens ? (
                  <p className="text-[10px] text-muted-foreground">Tokens: {tokens}</p>
                ) : null}
                <DetailBlock
                  label="Retrieved facts and context"
                  value={detail.retrievedFacts?.join('\n')}
                />
                <DetailBlock label="Decision summary" value={detail.decisionSummary} />
                <DetailBlock label="Execution result" value={detail.execution?.result} />
                <DetailBlock label="Error" value={detail.execution?.error} />
              </CollapsibleContent>
            </Collapsible>
          )
        })}
      </div>
      <ImageLightbox
        image={
          selectedScreenshot
            ? { ...selectedScreenshot, dialogLabel: 'Task screenshot preview' }
            : null
        }
        onClose={() => setSelectedScreenshot(null)}
      />
    </>
  )
}
