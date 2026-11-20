import { WarningCircleIcon } from '@phosphor-icons/react'
import { explainFailure, type Failure, type FailureContext, type FailureStep } from '@offgrid/failures'
import { Button } from './ui/button'
import { cn } from '@/lib/utils'

/** Where a failure's step goes on desktop. The wording and the step come from @offgrid/failures. */
export function openFailureStep(step: Extract<FailureStep, { kind: 'open' }>): void {
  const navigate = (detail: unknown): void => {
    window.dispatchEvent(new CustomEvent('og:navigate', { detail }))
  }
  switch (step.target) {
    case 'models':
      navigate({ view: 'models', subroute: step.tab && step.tab !== 'vision' ? step.tab : 'text' })
      return
    case 'storage':
      navigate({ view: 'models', subroute: 'storage' })
      return
    case 'sync':
    case 'pairing':
      navigate({ view: 'devices' })
      return
    case 'integrations':
      navigate({ view: 'connectors' })
      return
    case 'microphone':
      void window.api.openMicrophoneSettings()
      return
    case 'permissions':
    case 'screen-recording':
    case 'app-settings':
      navigate({ view: 'settings', section: 'permissions' })
      return
    case 'upgrade':
      navigate({ view: 'settings', section: 'pro-plan' })
      return
  }
}

/**
 * Why something failed, in one line, with its one next step, shown where the action was taken.
 *
 * Pass what was thrown (or a reason string) and the words only the screen knows. A retry step shows
 * only when the screen can retry (`onRetry`); an open step always works, through app navigation.
 */
export function FailureNotice({
  error,
  failure,
  context,
  onRetry,
  className
}: Readonly<{
  error?: unknown
  failure?: Failure
  context?: FailureContext
  onRetry?: () => void
  className?: string
}>): React.JSX.Element {
  const shown = failure ?? explainFailure(error, context)
  const step = shown.step
  const action =
    step?.kind === 'open'
      ? (): void => openFailureStep(step)
      : step && onRetry
        ? onRetry
        : undefined
  return (
    <div
      role="alert"
      className={cn(
        'flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-1.5 text-xs text-red-300',
        className
      )}
    >
      <WarningCircleIcon className="h-3.5 w-3.5 shrink-0" weight="fill" aria-hidden />
      <span className="min-w-0 flex-1">{shown.line}</span>
      {step && action ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={action}
          className="shrink-0 border-red-500/30 bg-transparent text-red-200 hover:text-white active:scale-95"
        >
          {step.label}
        </Button>
      ) : null}
    </div>
  )
}
