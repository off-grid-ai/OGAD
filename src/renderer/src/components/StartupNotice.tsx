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

/**
 * The parts of the app a degradation can name, in the user's words. A report identifies its domain
 * internally ('rag', 'use'); nobody outside this codebase knows what those are, so nothing raw from
 * a report is ever shown. Keys are the six `OffGridDomain` values, so this is exhaustive - an
 * unrecognised one falls back to the vague sentence rather than leaking a codeword.
 */
const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  models: 'Your models',
  sync: 'Sync',
  rag: 'Search',
  speech: 'Voice',
  automation: 'Automated tasks',
  use: 'Assistant actions'
}

/**
 * Every part named by a degradation, once each, in the order they were reported.
 *
 * Reports are keyed by REPORTER, not by domain, so two owners of one domain produce two entries -
 * de-duplicated here so a user is never told "Search and Search". Report order is preserved as-is:
 * entries arrive from different places at different times (startup stages during boot, runtime
 * failures like search losing its embedding half long after), and which of those matters more to
 * the person reading is not something this strip can know, so it does not rank them.
 */
function degradedNames(degraded: StartupSnapshotContract['degraded']): string[] {
  const names: string[] = []
  for (const entry of degraded) {
    const label = DOMAIN_LABELS[entry.domain]
    if (label && !names.includes(label)) names.push(label)
  }
  return names
}

/** 'Search' / 'Search and Voice' / 'Your models, Search, and Voice'. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1) ?? ''}`
}

/**
 * LIMITED, never "unavailable". A degradation is defined by its own contract as a domain that is
 * "up but not whole" - reduced, not gone - so "unavailable" asserts a state the app is not in.
 * Search is the clearest case: it publishes a degradation when its semantic half cannot run, and
 * the keyword half still returns real results, so a user told search was unavailable would be able
 * to search anyway. One weaker word, true for every domain, beats a stronger one that is false for
 * some. The word stays uniform because the snapshot does not say WHICH capability of a domain is
 * reduced, and inventing a per-domain fallback claim would be the same defect again.
 */
function limitedSentence(names: readonly string[]): string {
  return `${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} limited.`
}

function degradedLabel(snapshot: StartupSnapshotContract): string {
  const parts: string[] = []

  const failed = snapshot.stages.find(
    (stage) => stage.status === 'failed' || stage.status === 'timeout'
  )
  const failedLabel = failed ? STAGE_LABELS[failed.name] : undefined
  // Something arrived after its deadline. Worth saying, because the app took longer than it
  // should have and the user may have watched it happen - but it is here, so it is not a failure.
  const late = snapshot.stages.find((stage) => stage.status === 'late')
  const lateLabel = late ? STAGE_LABELS[late.name] : undefined
  if (failedLabel) parts.push(`${failedLabel} didn't finish.`)
  else if (lateLabel) parts.push(`${lateLabel} took longer than expected, but it's ready.`)

  // Appended, never substituted. A stage problem used to be the whole sentence, which hid every
  // degradation reported after boot - so the one thing the user could act on was the one thing
  // they were not told about. Both are said now, and each named part is said.
  //
  // Nothing is added about the REST of the app. This strip is handed a list of what is reduced; it
  // is never told that nothing else is, so it used to close with "Everything else works." - a claim
  // about the whole application derived from a list that cannot support it. It says what it knows
  // and stops.
  const names = degradedNames(snapshot.degraded)
  if (names.length > 0) parts.push(limitedSentence(names))
  else if (parts.length === 0) parts.push('Part of the app is limited.')

  return parts.join(' ')
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
