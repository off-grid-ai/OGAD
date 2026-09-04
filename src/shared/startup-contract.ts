/**
 * Where startup is, on the wire.
 *
 * The first window opens before startup finishes, so "not ready yet" has to be something the
 * renderer can read and render. This is that shape: the phase, the stages still running, the
 * domains that came up degraded, and why the application root failed when it did.
 */
import type {
  ApplicationDegradation,
  ApplicationLifecycleFailure,
  ApplicationStatus
} from '@offgrid/application'

export type StartupPhaseContract = 'pending' | 'ready' | 'degraded' | 'failed'

export type StartupStageStatusContract = 'running' | 'completed' | 'failed' | 'timeout'

export interface StartupStageContract {
  readonly name: string
  readonly status: StartupStageStatusContract
  /** Absent while the stage is still running. */
  readonly durationMs?: number
  /** Present on `failed` and `timeout`, in the words the failing owner used. */
  readonly error?: string
  /** A required stage failing means the product did not start; an optional one means degraded. */
  readonly required: boolean
}

export interface StartupSnapshotContract {
  readonly phase: StartupPhaseContract
  readonly applicationStatus: ApplicationStatus
  /** Stage names that have not settled yet. */
  readonly running: readonly string[]
  readonly stages: readonly StartupStageContract[]
  readonly degraded: readonly ApplicationDegradation[]
  readonly lifecycleFailure: ApplicationLifecycleFailure | null
}
