export type StartupPhase = 'pending' | 'ready' | 'degraded' | 'failed'

export type StartupStageStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'late'

export interface StartupStageSnapshot {
  readonly name: string
  readonly status: StartupStageStatus
  readonly required: boolean
  readonly durationMs?: number
  readonly error?: string
}

export interface StartupSnapshot {
  readonly revision: number
  readonly phase: StartupPhase
  readonly running: readonly string[]
  readonly stages: readonly StartupStageSnapshot[]
}
