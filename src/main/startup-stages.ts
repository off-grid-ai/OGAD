/**
 * One bounded, observable step of desktop startup.
 *
 * Startup used to be a sequential chain of bare `await`s: one slow or hanging step - an online
 * licence revalidation, a model catalog repair, a domain that never resolves - held the first
 * window closed for as long as it took, and its failure was a console line nobody could see from
 * a surface.
 *
 * Every stage now has a deadline, a cancellation signal, a typed result, and a timing recorded
 * through the bounded diagnostic path. A stage that fails or times out returns that as a value, so
 * its caller decides whether the product continues degraded or not - it can no longer decide by
 * throwing, and it can no longer decide by hanging.
 */
import { writeDiagnosticLog } from './diagnostics-log'
import { reportDesktopApplicationDegraded } from './composition/application-access'
import type { OffGridDomain } from '@offgrid/application'

/** Who reported it, so a domain's own report and a startup report never overwrite each other. */
export const STARTUP_DEGRADATION_SOURCE = 'startup'

export type StartupStageResult<T> =
  | { readonly ok: true; readonly value: T; readonly durationMs: number }
  | {
      readonly ok: false
      readonly reason: 'failed' | 'timeout'
      readonly error: string
      readonly durationMs: number
    }

export interface StartupStage<T> {
  /** Stable, grep-friendly stage name, e.g. `pro.entitlement.revalidate`. */
  readonly name: string
  /** Hard deadline. The stage's signal is aborted when it passes. */
  readonly deadlineMs: number
  /**
   * The domain this stage belongs to, when it has one. A failure is published on the shared
   * degraded projection under that domain so a surface can say why it is degraded.
   */
  readonly domain?: OffGridDomain
  readonly run: (signal: AbortSignal) => Promise<T>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one stage. Never throws: the caller gets a value describing what happened.
 *
 * The deadline aborts the stage's signal AND settles the wait, because work behind a port that
 * ignores its signal must not be able to hold startup open regardless.
 */
export async function runStartupStage<T>(stage: StartupStage<T>): Promise<StartupStageResult<T>> {
  const startedAt = Date.now()
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, stage.deadlineMs)
    timer.unref()
  })

  try {
    const outcome = await Promise.race([
      stage.run(controller.signal).then((value) => ({ value }) as const),
      deadline
    ])
    const durationMs = Date.now() - startedAt
    if (outcome === 'timeout') {
      return settleFailure(
        stage,
        { reason: 'timeout', error: `exceeded ${stage.deadlineMs}ms` },
        durationMs
      )
    }
    // Deliberately no clear-on-success: the degraded projection is keyed by (domain, source), so
    // one stage succeeding would erase a SIBLING stage's failure on the same domain.
    writeDiagnosticLog('startup', 'stage.completed', { stage: stage.name, durationMs })
    return { ok: true, value: outcome.value, durationMs }
  } catch (error) {
    return settleFailure(
      stage,
      { reason: 'failed', error: describe(error) },
      Date.now() - startedAt
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function settleFailure<T>(
  stage: StartupStage<T>,
  failure: { readonly reason: 'failed' | 'timeout'; readonly error: string },
  durationMs: number
): StartupStageResult<T> {
  const { reason, error } = failure
  writeDiagnosticLog(
    'startup',
    reason === 'timeout' ? 'stage.timeout' : 'stage.failed',
    { stage: stage.name, durationMs, error },
    'error'
  )
  if (stage.domain) {
    reportDesktopApplicationDegraded({
      domain: stage.domain,
      source: STARTUP_DEGRADATION_SOURCE,
      reason: `${stage.name}: ${error}`
    })
  }
  return { ok: false, reason, error, durationMs }
}

/**
 * Run independent stages together and report each one's result.
 *
 * The dependency graph is the caller's: what arrives here has no order between its members, so a
 * blind sequential chain would only be adding each stage's latency to every other stage's.
 */
export function runIndependentStartupStages(
  stages: readonly StartupStage<unknown>[]
): Promise<readonly StartupStageResult<unknown>[]> {
  return Promise.all(stages.map((stage) => runStartupStage(stage)))
}
