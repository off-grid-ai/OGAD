import { WarningCircle } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import type { StartupSnapshot } from '../../../shared/startup-contract'
import { LoadingDots } from './ui/loading-dots'

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
  'models.text.prepare': 'Loading your model',
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

export function StartupNotice(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<StartupSnapshot | null>(null)
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

  if (!snapshot || snapshot.phase === 'ready') return null

  if (snapshot.phase === 'failed') {
    return (
      <div
        role="status"
        aria-live="assertive"
        className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-red-950/90 px-4 py-1.5 font-mono text-[11px] text-red-200"
      >
        <WarningCircle size={13} weight="bold" aria-hidden />
        <span>Off Grid AI Desktop could not finish startup. Restart the app.</span>
      </div>
    )
  }

  if (snapshot.phase === 'degraded') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-amber-950/80 px-4 py-1.5 font-mono text-[11px] text-amber-200"
      >
        <WarningCircle size={13} aria-hidden />
        <span>{degradedText(snapshot)}</span>
      </div>
    )
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-neutral-900/85 px-4 py-1.5 font-mono text-[11px] text-neutral-400"
    >
      <span>{pendingText(snapshot)}</span>
      <LoadingDots size="small" />
    </div>
  )
}
