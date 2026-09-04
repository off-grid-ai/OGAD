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
   * This run's identity, for correlating a stage with the events its work emits - and, where the
   * owner supports it, for SUPERSESSION.
   *
   * `models.prepare` now compares it: a prepare whose operation is no longer the newest for its
   * modality emits `model_prepare_superseded` and returns the typed `superseded` failure instead of
   * reporting success, and its work is told through `context.superseded()` so it can decline before
   * it applies. So passing the same id to a prepare makes a late completion REFUSED, not merely
   * attributable.
   *
   * Two limits, because a guarantee is worth only what its limits are. Other owners still do not
   * compare it - only prepare does today - so for anything else this stays a correlation id.
   * And even for prepare, a native load already in flight when a newer prepare arrives will finish
   * and leave that model resident; what is refused is the ANSWER, not that last effect. Anything
   * that must not LAND late still needs `commit`, or an owner that refuses it.
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

  // Counted, because the late report must say what the code KNOWS. A stage that never called
  // `commit` has told this machinery nothing about whether it changed state, and reporting that
  // its late effect was "refused" would claim a guard that was never asked to run.
  let commitsApplied = 0
  let commitsRefused = 0
  const context: StartupStageContext = {
    signal: controller.signal,
    operationId,
    isOwner: () => owned,
    commit: <R>(label: string, apply: () => R): R | undefined => {
      if (owned) {
        commitsApplied += 1
        return apply()
      }
      commitsRefused += 1
      writeDiagnosticLog(
        'startup',
        'stage.late-commit-refused',
        { stage: stage.name, operationId, change: label },
        'error'
      )
      return undefined
    }
  }

  // Deferred through a resolved promise so a SYNCHRONOUS throw from `run` becomes a rejection
  // this function handles, rather than escaping before the try: it used to leave the timer
  // running, the stage reading as pending forever, and `runIndependentStartupStages` rejecting
  // early instead of collecting a typed failure.
  const work = Promise.resolve().then(() => stage.run(context))
  try {
    const outcome = await Promise.race([work.then((value) => ({ value }) as const), deadline])
    const durationMs = Date.now() - startedAt
    if (outcome === 'timeout') {
      observeLateSettlement({
        stage,
        work,
        operationId,
        startedAt,
        commits: () => ({ applied: commitsApplied, refused: commitsRefused })
      })
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
 * What is actually known about a late effect.
 *
 * `refused` is claimed ONLY when this machinery refused something: at least one `commit` was
 * turned away after the deadline and none was applied. A stage that never called `commit` has told
 * us nothing, so it reports `unguarded` - which is the truth, and is meant to read as a gap rather
 * than as safety.
 */
function lateEffectOf<T>(
  stage: StartupStage<T>,
  commits: { readonly applied: number; readonly refused: number }
): 'kept' | 'refused' | 'unguarded' {
  if (stage.lateEffectIsRecoverable === true) return 'kept'
  if (commits.refused > 0 && commits.applied === 0) return 'refused'
  return 'unguarded'
}

/**
 * Keep watching work the deadline abandoned.
 *
 * A timed-out stage's promise is still running, and dropping it would mean its eventual outcome is
 * never seen at all: a rejection would surface as an unhandled rejection, and a success would
 * change the world with nothing recording that it did. So it is reported as `late` - the app is not
 * permanently broken because something arrived slowly, and it is not clean either.
 */
function observeLateSettlement<T>(input: {
  readonly stage: StartupStage<T>
  readonly work: Promise<T>
  readonly operationId: string
  readonly startedAt: number
  readonly commits: () => { readonly applied: number; readonly refused: number }
}): void {
  const { stage, work, operationId, startedAt } = input
  void work.then(
    () => {
      const durationMs = Date.now() - startedAt
      const commits = input.commits()
      writeDiagnosticLog(
        'startup',
        'stage.late-completion',
        {
          stage: stage.name,
          operationId,
          durationMs,
          effect: lateEffectOf(stage, commits),
          commitsApplied: commits.applied,
          commitsRefused: commits.refused
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
    // The degradation report must never be able to fail the FAILURE HANDLER. It reaches shared
    // application health, which can be unavailable - and when it threw, `settleFailure` rejected,
    // so the stage's diagnostic never finished, the startup projection was never updated, and the
    // observable result was an unhandled rejection instead of a reported failure. A reporting
    // problem was hiding the very problem it was reporting.
    //
    // Not swallowed: the report's own failure gets its OWN diagnostic, under its own event name, so
    // it is distinguishable from the stage failure that triggered it. And no second health store is
    // created for it - there is one owner of degradation, it was simply unreachable.
    try {
      reportDesktopApplicationDegraded({
        domain: stage.domain,
        source: STARTUP_DEGRADATION_SOURCE,
        reason: `${stage.name}: ${error}`
      })
    } catch (reportError) {
      writeDiagnosticLog(
        'startup',
        'stage.degradation-report-failed',
        { stage: stage.name, domain: stage.domain, error: describe(reportError) },
        'error'
      )
    }
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
