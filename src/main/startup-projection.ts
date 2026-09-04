/**
 * Where the app is in its own startup, as READABLE STATE.
 *
 * The first window used to be held closed until startup finished, which is a way of representing
 * "not ready yet" that costs the user the whole shell. The shell opens early now, so "not ready
 * yet" has to be something a surface can render instead: pending while stages are still settling,
 * degraded when an optional domain did not come up, failed when the application itself could not
 * start, ready when there is nothing left to say.
 *
 * Pure state with an injected lifecycle source: no Electron, no IPC and no imports of the
 * composition root, so this module cannot decide when the application is constructed and cannot be
 * the reason it is.
 */
import type {
  ApplicationDegradation,
  ApplicationLifecycleFailure,
  ApplicationStatus
} from '@offgrid/application'
import type {
  StartupPhaseContract,
  StartupSnapshotContract,
  StartupStageContract
} from '../shared/startup-contract'

// The wire contract IS the projection: one shape, so main cannot publish something the renderer
// does not expect.
export type StartupPhase = StartupPhaseContract
export type StartupStageReport = StartupStageContract
export type StartupSnapshot = StartupSnapshotContract

export interface StartupLifecycleSource {
  snapshot(): {
    readonly status: ApplicationStatus
    readonly degraded: readonly ApplicationDegradation[]
    readonly lifecycleFailure: ApplicationLifecycleFailure | null
  }
  subscribe(listener: () => void): () => void
}

export interface StartupProjection {
  snapshot(): StartupSnapshot
  subscribe(listener: (snapshot: StartupSnapshot) => void): () => void
  /** A stage has begun. Recording it is what makes `pending` mean something specific. */
  stageStarted(stage: { readonly name: string; readonly required: boolean }): void
  stageSettled(report: StartupStageReport): void
  /** Mirror the application root's own lifecycle. Returns the release for its subscription. */
  observe(source: StartupLifecycleSource): () => void
}

const EMPTY_DEGRADED: readonly ApplicationDegradation[] = []

/**
 * One rule for the phase, so two surfaces cannot disagree about whether the app is up.
 *
 * A required stage failing outranks everything: nothing else is worth reporting if the application
 * root did not start. Otherwise anything unsettled is `pending` - it may still succeed, and calling
 * it degraded would tell the user something is broken while it is merely slow.
 */
export function startupPhase(input: {
  readonly applicationStatus: ApplicationStatus
  readonly stages: readonly StartupStageReport[]
  readonly degraded: readonly ApplicationDegradation[]
  readonly lifecycleFailure: ApplicationLifecycleFailure | null
}): StartupPhase {
  const settledBadly = (report: StartupStageReport): boolean =>
    report.status === 'failed' || report.status === 'timeout'
  if (input.lifecycleFailure) return 'failed'
  if (input.stages.some((report) => report.required && settledBadly(report))) return 'failed'
  if (input.stages.some((report) => report.status === 'running')) return 'pending'
  if (input.applicationStatus !== 'started') return 'pending'
  if (input.degraded.length > 0 || input.stages.some(settledBadly)) return 'degraded'
  return 'ready'
}

export function createStartupProjection(): StartupProjection {
  const stages = new Map<string, StartupStageReport>()
  const listeners = new Set<(snapshot: StartupSnapshot) => void>()
  let applicationStatus: ApplicationStatus = 'created'
  let degraded: readonly ApplicationDegradation[] = EMPTY_DEGRADED
  let lifecycleFailure: ApplicationLifecycleFailure | null = null
  let current: StartupSnapshot = {
    phase: 'pending',
    applicationStatus,
    running: [],
    stages: [],
    degraded,
    lifecycleFailure: null
  }

  const publish = (): void => {
    const reports = [...stages.values()]
    const next: StartupSnapshot = {
      phase: startupPhase({ applicationStatus, stages: reports, degraded, lifecycleFailure }),
      applicationStatus,
      running: reports.filter((r) => r.status === 'running').map((r) => r.name),
      stages: reports,
      degraded,
      lifecycleFailure
    }
    // An identical snapshot publishes nothing: a surface that renders this must not repaint because
    // an unrelated domain event went past.
    if (
      next.phase === current.phase &&
      next.applicationStatus === current.applicationStatus &&
      next.running.length === current.running.length &&
      next.stages.length === current.stages.length &&
      next.degraded === current.degraded &&
      next.lifecycleFailure === current.lifecycleFailure &&
      next.running.every((name, index) => name === current.running[index]) &&
      next.stages.every((report, index) => report === current.stages[index])
    ) {
      return
    }
    current = next
    for (const listener of listeners) listener(current)
  }

  return {
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    stageStarted: ({ name, required }) => {
      stages.set(name, { name, status: 'running', required })
      publish()
    },
    stageSettled: (report) => {
      stages.set(report.name, report)
      publish()
    },
    observe: (source) => {
      const read = (): void => {
        const snapshot = source.snapshot()
        applicationStatus = snapshot.status
        degraded = snapshot.degraded
        lifecycleFailure = snapshot.lifecycleFailure
        publish()
      }
      read()
      const release = source.subscribe(read)
      return () => release()
    }
  }
}

/** The one startup projection for this process. */
export const startupProjection: StartupProjection = createStartupProjection()
