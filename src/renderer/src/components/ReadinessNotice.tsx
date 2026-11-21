import { InfoIcon } from '@phosphor-icons/react'
import { t } from '@offgrid/i18n'
import type { Readiness } from '@offgrid/features'
import { cn } from '@/lib/utils'
import { readinessHandler, type ReadinessHandlers } from '@/lib/readiness-actions'

/**
 * Why a feature cannot run now, in one line, and its one next step (shared @offgrid/features readiness).
 * Renders nothing when the feature is ready.
 */
export function ReadinessNotice({
  readiness,
  className,
  ...handlers
}: Readonly<
  { readiness: Readiness; className?: string } & ReadinessHandlers
>): React.JSX.Element | null {
  if (readiness.ready) return null
  const steps = [readiness.action, readiness.also].flatMap((action) => {
    const run = action ? readinessHandler(action, handlers) : undefined
    return action && run ? [{ label: action.label, run }] : []
  })
  return (
    <p
      role="status"
      className={cn(
        'm-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-400',
        className
      )}
    >
      <InfoIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{t(readiness.line, ...readiness.lineArgs)}</span>
      {steps.map((step) => (
        <button
          key={step.label}
          type="button"
          onClick={step.run}
          className="text-green-500 transition-colors hover:text-green-400 hover:underline"
        >
          {t(step.label)}
        </button>
      ))}
    </p>
  )
}
