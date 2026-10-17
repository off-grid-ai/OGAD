import { WarningCircle } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import type { StartupSnapshot } from '../../../shared/startup-contract'

const EASE = [0.16, 1, 0.3, 1] as const

const STAGE_LABELS: Readonly<Record<string, string>> = {
  'pro.entitlement.load-cached': 'Checking your license',
  'core.ipc': 'Starting Off Grid AI Desktop',
  'actions.ipc': 'Starting actions',
  'browser.view.ipc': 'Starting Web Use',
  'vision.ipc': 'Starting Computer Use',
  'vision.supervisor-window': 'Starting Computer Use',
  'tasks.history.ipc': 'Opening your tasks',
  'pro.entitlement.revalidate': 'Confirming your license',
  'models.gateway.start': 'Starting the local API',
  'media.server.start': 'Preparing media playback',
  'models.text.prepare': 'Preparing your model',
  'modalities.runtime.register': 'Preparing local models',
  'models.projector.reconcile': 'Checking your models',
  'pro.features.load': 'Starting Pro features',
  'updater.ipc': 'Checking for updates'
}

function labelFor(stageName: string | undefined): string | undefined {
  return stageName ? STAGE_LABELS[stageName] : undefined
}

function pendingText(snapshot: StartupSnapshot): string {
  return labelFor(snapshot.running[0]) ?? 'Starting Off Grid AI Desktop'
}

function degradedText(snapshot: StartupSnapshot): string {
  const failed = snapshot.stages.find(
    (stage) => stage.status === 'failed' || stage.status === 'timeout'
  )
  const failedLabel = labelFor(failed?.name)
  if (failedLabel) return `${failedLabel} did not finish. The rest of the app is ready.`

  const late = snapshot.stages.find((stage) => stage.status === 'late')
  const lateLabel = labelFor(late?.name)
  return lateLabel
    ? `${lateLabel} took longer than expected, but it is ready.`
    : 'Part of the app took longer than expected, but it is ready.'
}

export function StartupNotice(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<StartupSnapshot | null>(null)
  const reduceMotion = useReducedMotion()
  const applySnapshot = useCallback((next: StartupSnapshot): void => {
    setSnapshot((current) => (!current || next.revision >= current.revision ? next : current))
  }, [])

  useEffect(() => {
    let mounted = true
    const unsubscribe = window.api.onStartupStatusChanged((next) => {
      if (mounted) applySnapshot(next)
    })
    void window.api
      .startupStatus()
      .then((next) => {
        if (mounted) applySnapshot(next)
      })
      .catch(() => {})

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [applySnapshot])

  const phase = snapshot && snapshot.phase !== 'ready' ? snapshot.phase : null

  // The banner drops in from the top edge and lifts away when startup settles; each stage's
  // label dissolves into the next instead of swapping.
  return (
    <AnimatePresence>
      {snapshot && phase ? (
        <motion.div
          key={phase}
          role="status"
          aria-live={phase === 'failed' ? 'assertive' : 'polite'}
          initial={reduceMotion ? false : { opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={{ duration: reduceMotion ? 0 : 0.4, ease: EASE }}
          className={`pointer-events-none absolute inset-x-0 top-0 z-50 flex items-center justify-center gap-2 px-4 py-1.5 font-mono text-[11px] ${
            phase === 'failed'
              ? 'bg-red-950/90 text-red-200'
              : phase === 'degraded'
                ? 'bg-amber-950/80 text-amber-200'
                : 'bg-neutral-900/85 text-neutral-400'
          }`}
        >
          {phase === 'failed' ? (
            <>
              <WarningCircle size={13} weight="bold" aria-hidden />
              <span>Off Grid AI Desktop could not finish startup. Restart the app.</span>
            </>
          ) : (
            <>
              {phase === 'degraded' ? <WarningCircle size={13} aria-hidden /> : null}
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={phase === 'degraded' ? degradedText(snapshot) : pendingText(snapshot)}
                  initial={reduceMotion ? false : { opacity: 0, y: 4, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, filter: 'blur(4px)' }}
                  transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE }}
                >
                  {phase === 'degraded' ? (
                    degradedText(snapshot)
                  ) : (
                    <TextShimmer as="span">{pendingText(snapshot)}</TextShimmer>
                  )}
                </motion.span>
              </AnimatePresence>
            </>
          )}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
