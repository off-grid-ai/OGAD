import { writeDiagnosticLog } from './diagnostics-log'
import { startupProjection } from './startup-projection'

export type StartupStageResult<T> =
  | { readonly ok: true; readonly value: T; readonly durationMs: number }
  | {
      readonly ok: false
      readonly reason: 'failed' | 'timeout'
      readonly error: string
      readonly durationMs: number
    }

export interface StartupStageContext {
  readonly signal: AbortSignal
  isOwner(): boolean
  commit<R>(label: string, apply: () => R): R | undefined
}

interface StartupStageBase<T> {
  readonly name: string
  readonly deadlineMs: number
  readonly required?: boolean
  readonly run: (context: StartupStageContext) => Promise<T> | T
}

export type StartupStage<T> = StartupStageBase<T> &
  (
    | { readonly lateEffect: 'keep' }
    | {
        readonly lateEffect: 'guard'
        readonly run: (context: StartupStageContext) => Promise<T> | T
      }
  )

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function settleFailure<T>(input: {
  readonly stage: StartupStage<T>
  readonly reason: 'failed' | 'timeout'
  readonly error: string
  readonly durationMs: number
}): StartupStageResult<T> {
  const { stage, reason, error, durationMs } = input
  writeDiagnosticLog(
    'startup',
    reason === 'timeout' ? 'stage.timeout' : 'stage.failed',
    { stage: stage.name, durationMs, error },
    'error'
  )
  startupProjection.stageSettled({
    name: stage.name,
    status: reason,
    required: stage.required === true,
    durationMs,
    error
  })
  return { ok: false, reason, error, durationMs }
}

export async function runStartupStage<T>(stage: StartupStage<T>): Promise<StartupStageResult<T>> {
  const startedAt = Date.now()
  const required = stage.required === true
  const controller = new AbortController()
  let owned = true
  let commitsApplied = 0
  let commitsRefused = 0
  let timer: NodeJS.Timeout | undefined

  startupProjection.stageStarted({ name: stage.name, required })

  const context: StartupStageContext = {
    signal: controller.signal,
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
        { stage: stage.name, change: label },
        'error'
      )
      return undefined
    }
  }

  const work = Promise.resolve().then(() => stage.run(context))
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      owned = false
      controller.abort()
      resolve('timeout')
    }, stage.deadlineMs)
    timer.unref()
  })

  try {
    const outcome = await Promise.race([work.then((value) => ({ value }) as const), deadline])
    const durationMs = Date.now() - startedAt
    if (outcome === 'timeout') {
      void work.then(
        () => {
          const lateDurationMs = Date.now() - startedAt
          const kept = stage.lateEffect === 'keep'
          const effect = kept ? 'kept' : commitsRefused > 0 ? 'guarded' : 'no-guarded-change'
          writeDiagnosticLog(
            'startup',
            'stage.late-completion',
            {
              stage: stage.name,
              durationMs: lateDurationMs,
              effect,
              commitsApplied,
              commitsRefused
            },
            'warn'
          )
          if (kept) {
            startupProjection.stageSettled({
              name: stage.name,
              status: 'late',
              required,
              durationMs: lateDurationMs,
              error: `settled ${lateDurationMs - stage.deadlineMs}ms after its deadline`
            })
          }
        },
        (error: unknown) => {
          writeDiagnosticLog(
            'startup',
            'stage.late-failure',
            { stage: stage.name, durationMs: Date.now() - startedAt, error: describe(error) },
            'error'
          )
        }
      )
      return settleFailure({
        stage,
        reason: 'timeout',
        error: `exceeded ${stage.deadlineMs}ms`,
        durationMs
      })
    }

    owned = false
    writeDiagnosticLog('startup', 'stage.completed', { stage: stage.name, durationMs })
    startupProjection.stageSettled({
      name: stage.name,
      status: 'completed',
      required,
      durationMs
    })
    return { ok: true, value: outcome.value, durationMs }
  } catch (error) {
    owned = false
    return settleFailure({
      stage,
      reason: 'failed',
      error: describe(error),
      durationMs: Date.now() - startedAt
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function runIndependentStartupStages(
  stages: readonly StartupStage<unknown>[]
): Promise<readonly StartupStageResult<unknown>[]> {
  return Promise.all(stages.map((stage) => runStartupStage(stage)))
}
