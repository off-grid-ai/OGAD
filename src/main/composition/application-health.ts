/**
 * Startup health as observable state, not a log line.
 *
 * Shared's application root reports its own degradation twice: `ApplicationStartResult.degraded`
 * for a domain that could not start, and `lifecycleFailure` on the snapshot for consumers that
 * subscribe after `start()` settled. Anything that activates BESIDE that root - Pro's Sync
 * activation is the one case today - has no way to publish into either, so its failure used to
 * live only in a console line and no surface could say WHY sync is degraded.
 *
 * This store is the desktop-side answer while that gap is open (the request for a shared-owned
 * post-start degradation report is recorded in
 * `shared/docs/hexagonal-program-2/WIRING_A.md`): one typed projection, fed by shared's own start
 * result and by every extension that activates beside it, observable by any main-process consumer
 * and renderable by a surface. Pure by construction - the diagnostic sink is injected, so this
 * module performs no I/O and is unit-testable as a state machine.
 */
import type {
  ApplicationLifecycleFailure,
  ApplicationStatus,
  OffGridDomain
} from '@offgrid/application'

/** Who reported the degradation: shared's own startup, or an extension activating beside it. */
export type ApplicationHealthSource = 'application' | 'pro'

export interface ApplicationDegradation {
  readonly domain: OffGridDomain
  readonly source: ApplicationHealthSource
  /** Why the domain is degraded, in the words the failing owner used. */
  readonly reason: string
}

export interface ApplicationHealthSnapshot {
  readonly status: ApplicationStatus
  /** Every domain currently running degraded, in report order. */
  readonly degraded: readonly ApplicationDegradation[]
  readonly lifecycleFailure: ApplicationLifecycleFailure | null
}

/** Where a recorded change is also written for support. Injected so this module stays pure. */
export type ApplicationHealthSink = (entry: ApplicationDegradation) => void

export interface ApplicationHealth {
  snapshot(): ApplicationHealthSnapshot
  subscribe(listener: (snapshot: ApplicationHealthSnapshot) => void): () => void
  /** Mirror shared's own lifecycle projection so one read answers "is the app healthy". */
  observeLifecycle(lifecycle: {
    readonly status: ApplicationStatus
    readonly lifecycleFailure: ApplicationLifecycleFailure | null
  }): void
  /** One owner, one current reason: a second report for the same owner replaces the first. */
  reportDegraded(entry: ApplicationDegradation): void
  /** The owner recovered (or started cleanly on a retry): drop its entry. */
  clearDegraded(domain: OffGridDomain, source: ApplicationHealthSource): void
  /** Install the support-log sink. The last installer wins; passing null removes it. */
  setSink(sink: ApplicationHealthSink | null): void
}

const key = (domain: OffGridDomain, source: ApplicationHealthSource): string =>
  `${source}:${domain}`

export function createApplicationHealth(): ApplicationHealth {
  const entries = new Map<string, ApplicationDegradation>()
  let sink: ApplicationHealthSink | null = null
  let current: ApplicationHealthSnapshot = {
    status: 'created',
    degraded: [],
    lifecycleFailure: null
  }
  const listeners = new Set<(snapshot: ApplicationHealthSnapshot) => void>()

  const publish = (next: Partial<ApplicationHealthSnapshot>): void => {
    const candidate: ApplicationHealthSnapshot = { ...current, ...next }
    if (
      candidate.status === current.status &&
      candidate.degraded === current.degraded &&
      candidate.lifecycleFailure === current.lifecycleFailure
    ) {
      return
    }
    current = candidate
    for (const listener of listeners) listener(current)
  }

  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    observeLifecycle({ status, lifecycleFailure }) {
      publish({ status, lifecycleFailure })
    },
    reportDegraded(entry) {
      const existing = entries.get(key(entry.domain, entry.source))
      if (existing && existing.reason === entry.reason) return
      entries.set(key(entry.domain, entry.source), entry)
      sink?.(entry)
      publish({ degraded: [...entries.values()] })
    },
    clearDegraded(domain, source) {
      if (!entries.delete(key(domain, source))) return
      publish({ degraded: [...entries.values()] })
    },
    setSink(next) {
      sink = next
    }
  }
}

/** The process-wide projection. Desktop composition feeds it; Pro activation reports into it. */
export const desktopApplicationHealth = createApplicationHealth()

/**
 * The one call an extension activating beside the application root makes when it cannot start.
 * The failure becomes observable state with a reason a surface can render, instead of a log line.
 */
export function reportApplicationDegraded(entry: ApplicationDegradation): void {
  desktopApplicationHealth.reportDegraded(entry)
}

/** The current degradation an owner reports for a domain, or null while it is healthy. */
export function applicationDegradation(
  domain: OffGridDomain,
  source: ApplicationHealthSource
): ApplicationDegradation | null {
  return findDegradation(desktopApplicationHealth.snapshot(), domain, source)
}

/** The same query over any snapshot, for a consumer that already holds one. */
export function findDegradation(
  snapshot: ApplicationHealthSnapshot,
  domain: OffGridDomain,
  source: ApplicationHealthSource
): ApplicationDegradation | null {
  return (
    snapshot.degraded.find((entry) => entry.domain === domain && entry.source === source) ?? null
  )
}

/** The same extension's success path: the domain is no longer degraded by that owner. */
export function clearApplicationDegraded(
  domain: OffGridDomain,
  source: ApplicationHealthSource
): void {
  desktopApplicationHealth.clearDegraded(domain, source)
}
