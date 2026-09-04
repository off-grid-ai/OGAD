/**
 * One bounded, observable step of desktop startup.
 *
 * Startup used to be a sequential chain of bare `await`s: one slow or hanging step - an online
 * licence revalidation, a model catalog repair, a domain that never resolves - held the first
 * window closed for as long as it took, and its failure was a console line nobody could see from
 * a surface.
 *
 * Every stage has a deadline, a cancellation signal, an operation id, a typed result, and a timing
 * recorded through the bounded diagnostic path. A stage that fails or times out returns that as a
 * value, so its caller decides whether the product continues degraded or not - it can no longer
 * decide by throwing, and it can no longer decide by hanging.
 *
 * And a deadline is a real boundary, not just a stopwatch. Racing one leaves the losing work
 * RUNNING, so a stage already reported as timed out could still come back and register a handler,
 * activate a runtime or claim the app is ready. `commit` is what closes that: an authoritative
 * change is applied only while the stage still owns its outcome, and a refused late change is
 * recorded rather than silently dropped. Work that settles after its deadline is reported as
 * `late` - visible, and never mistaken for either a clean start or a permanent failure.
 */
import { writeDiagnosticLog } from './diagnostics-log'
import { reportDesktopApplicationDegraded } from './composition/application-access'
import { startupProjection } from './startup-projection'
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

/** What a stage's work is given. Everything it needs to not outlive its own deadline. */
export interface StartupStageContext {
  /** Aborted when the deadline passes. Pass it to anything that accepts one. */
  readonly signal: AbortSignal
  /**
   * This run's identity, for an operation that cannot be cancelled but CAN be told apart from a
   * later one (`models.prepare`'s `operationId` is the case today).
   */
  readonly operationId: string
  /** False once the deadline has passed: this stage no longer owns its outcome. */
  isOwner(): boolean
  /**
   * Apply an authoritative change - register a handler, activate a runtime, replace state - only
   * while this stage still owns its outcome.
   *
   * After the deadline the caller has already been told this stage timed out and has acted on
   * that, so a change landing now would contradict the state everything else was built from.
   * Refused changes are recorded under `label`, because a silently skipped registration is
   * indistinguishable from one that never existed.
   */
  commit<R>(label: string, apply: () => R): R | undefined
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
  /**
   * The product did not start if this stage did not. Default false: an optional domain failing is
   * degradation, and treating it as a failed launch is how one unavailable feature comes to look
   * like a broken app.
   */
  readonly required?: boolean
  /**
   * When true, work that settles after the deadline is ALLOWED to keep its effect, and is only
   * reported as `late`. For a decision the product would rather have late than not at all - the
   * cached entitlement is the case today: refusing it would keep a licensed user on the free build
   * for the whole session, and the licence-change notifier already tells every window when it
   * lands. Everything else defaults to refusing late effects.
   */
  readonly lateEffectIsRecoverable?: boolean
  readonly run: (context: StartupStageContext) => Promise<T>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let stageSequence = 0

/**
 * Run one stage. Never throws: the caller gets a value describing what happened.
 *
 * The deadline aborts the stage's signal AND settles the wait, because work behind a port that
 * ignores its signal must not be able to hold startup open regardless. The abandoned work is still
 * watched to the end - see `observeLateSettlement`.
 */
export async function runStartupStage<T>(stage: StartupStage<T>): Promise<StartupStageResult<T>> {
  const startedAt = Date.now()
  const required = stage.required === true
  const operationId = `startup-${stage.name}-${++stageSequence}`
  // Recorded before it runs, so "pending" names the stage the user is actually waiting on rather
  // than being a bare spinner.
  startupProjection.stageStarted({ name: stage.name, required })
  const controller = new AbortController()
  let owned = true
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      owned = false
      controller.abort()
      resolve('timeout')
    }, stage.deadlineMs)
    timer.unref()
  })

  const context: StartupStageContext = {
    signal: controller.signal,
    operationId,
    isOwner: () => owned,
    commit: <R>(label: string, apply: () => R): R | undefined => {
      if (owned) return apply()
      writeDiagnosticLog(
        'startup',
        'stage.late-commit-refused',
        { stage: stage.name, operationId, change: label },
        'error'
      )
      return undefined
    }
  }

  const work = stage.run(context)
  try {
    const outcome = await Promise.race([work.then((value) => ({ value }) as const), deadline])
    const durationMs = Date.now() - startedAt
    if (outcome === 'timeout') {
      observeLateSettlement(stage, work, operationId, startedAt)
      return settleFailure(
        stage,
        { reason: 'timeout', error: `exceeded ${stage.deadlineMs}ms` },
        durationMs
      )
    }
    owned = false
    // Deliberately no clear-on-success: the degraded projection is keyed by (domain, source), so
    // one stage succeeding would erase a SIBLING stage's failure on the same domain.
    writeDiagnosticLog('startup', 'stage.completed', { stage: stage.name, durationMs })
    startupProjection.stageSettled({
      name: stage.name,
      status: 'completed',
      durationMs,
      required
    })
    return { ok: true, value: outcome.value, durationMs }
  } catch (error) {
    owned = false
    return settleFailure(
      stage,
      { reason: 'failed', error: describe(error) },
      Date.now() - startedAt
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Keep watching work the deadline abandoned.
 *
 * A timed-out stage's promise is still running, and dropping it would mean its eventual outcome is
 * never seen at all: a rejection would surface as an unhandled rejection, and a success would
 * change the world with nothing recording that it did. So it is reported as `late` - the app is not
 * permanently broken because something arrived slowly, and it is not clean either.
 */
function observeLateSettlement<T>(
  stage: StartupStage<T>,
  work: Promise<T>,
  operationId: string,
  startedAt: number
): void {
  void work.then(
    () => {
      const durationMs = Date.now() - startedAt
      writeDiagnosticLog(
        'startup',
        'stage.late-completion',
        {
          stage: stage.name,
          operationId,
          durationMs,
          effect: stage.lateEffectIsRecoverable === true ? 'kept' : 'refused'
        },
        'warn'
      )
      startupProjection.stageSettled({
        name: stage.name,
        status: 'late',
        durationMs,
        error: `settled ${durationMs - stage.deadlineMs}ms after its ${stage.deadlineMs}ms deadline`,
        required: stage.required === true
      })
    },
    (error: unknown) => {
      const durationMs = Date.now() - startedAt
      writeDiagnosticLog(
        'startup',
        'stage.late-failure',
        { stage: stage.name, operationId, durationMs, error: describe(error) },
        'error'
      )
      // The stage is already recorded as timed out and its failure reason is already on the
      // degraded projection: this is the same stage, not a second one, so it keeps that verdict.
    }
  )
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
  startupProjection.stageSettled({
    name: stage.name,
    status: reason === 'timeout' ? 'timeout' : 'failed',
    durationMs,
    error,
    required: stage.required === true
  })
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
