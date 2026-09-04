/**
 * What the shell says while the rest of the app is still coming up.
 *
 * The window used to be held closed until startup finished, so there was nothing to say. It opens
 * early now, which means a user can be looking at the app while a domain is still starting - and
 * the honest thing is to tell them, name what is missing, and get out of the way as soon as it is
 * ready. Nothing here blocks: the shell is fully usable behind this line.
 */
import { useEffect, useState } from 'react'
import { WarningCircle } from '@phosphor-icons/react'
import { LoadingDots } from './ui/loading-dots'
import type { StartupSnapshotContract } from '../../../shared/startup-contract'

/** The stage names a user can be told about, in their own terms. */
const STAGE_LABELS: Readonly<Record<string, string>> = {
  'application.construct': 'Starting up',
  'application.start': 'Starting up',
  'models.classification.reconcile': 'Checking your models',
  'models.text.prepare': 'Loading your model',
  'models.gateway.start': 'Starting the local API',
  'pro.entitlement.load-cached': 'Checking your licence',
  'pro.entitlement.revalidate': 'Confirming your licence',
  'pro.features.load': 'Starting Pro features',
  'rag.ipc': 'Opening your knowledge base',
  'media.server.start': 'Preparing media playback',
  'updater.ipc': 'Checking for updates'
}

function pendingLabel(running: readonly string[]): string {
  for (const name of running) {
    const label = STAGE_LABELS[name]
    if (label) return label
  }
  return 'Starting up'
}

function degradedLabel(snapshot: StartupSnapshotContract): string {
  const failed = snapshot.stages.find(
    (stage) => stage.status === 'failed' || stage.status === 'timeout'
  )
  const failedLabel = failed ? STAGE_LABELS[failed.name] : undefined
  if (failedLabel) return `${failedLabel} didn't finish. Everything else works.`
  // Something arrived after its deadline. Worth saying, because the app took longer than it
  // should have and the user may have watched it happen - but it is here, so it is not a failure.
  const late = snapshot.stages.find((stage) => stage.status === 'late')
  const lateLabel = late ? STAGE_LABELS[late.name] : undefined
  if (lateLabel) return `${lateLabel} took longer than expected, but it's ready.`
  const domain = snapshot.degraded[0]?.domain
  return domain
    ? `${domain} is unavailable. Everything else works.`
    : 'Part of the app is unavailable. Everything else works.'
}

export function StartupNotice(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<StartupSnapshotContract | null>(null)
  useEffect(() => {
    let live = true
    void window.api
      .startupStatus()
      .then((next) => {
        if (live) setSnapshot(next)
      })
      .catch(() => {
        // The read is a convenience: the push below is the authority, and a shell with no notice
        // is the correct fallback - never a fabricated "ready".
      })
    const off = window.api.onStartupStatusChanged(setSnapshot)
    return () => {
      live = false
      off()
    }
  }, [])

  if (!snapshot || snapshot.phase === 'ready') return null

  if (snapshot.phase === 'failed') {
    const reason = snapshot.lifecycleFailure?.message
    return (
      <div
        role="status"
        className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-red-950/90 px-4 py-1.5 font-mono text-[11px] text-red-200"
      >
        <WarningCircle size={13} weight="bold" aria-hidden />
        <span>
          {reason ? `Off Grid AI could not start: ${reason}` : 'Off Grid AI could not start.'}
        </span>
      </div>
    )
  }

  if (snapshot.phase === 'degraded') {
    return (
      <div
        role="status"
        className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-amber-950/80 px-4 py-1.5 font-mono text-[11px] text-amber-200"
      >
        <WarningCircle size={13} aria-hidden />
        <span>{degradedLabel(snapshot)}</span>
      </div>
    )
  }

  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-neutral-900/85 px-4 py-1.5 font-mono text-[11px] text-neutral-400"
    >
      <span>{pendingLabel(snapshot.running)}</span>
      <LoadingDots />
    </div>
  )
}
