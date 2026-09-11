import type {
  StartupPhase,
  StartupSnapshot,
  StartupStageSnapshot
} from '../shared/startup-contract'

export interface StartupProjection {
  snapshot(): StartupSnapshot
  subscribe(listener: (snapshot: StartupSnapshot) => void): () => void
  stageStarted(stage: { readonly name: string; readonly required: boolean }): void
  stageSettled(stage: StartupStageSnapshot): void
}

function phaseFor(stages: readonly StartupStageSnapshot[]): StartupPhase {
  const failed = (stage: StartupStageSnapshot): boolean =>
    stage.status === 'failed' || stage.status === 'timeout'

  if (stages.some((stage) => stage.required && failed(stage))) return 'failed'
  if (stages.some((stage) => stage.status === 'running')) return 'pending'
  if (stages.some((stage) => failed(stage) || stage.status === 'late')) return 'degraded'
  return stages.length > 0 ? 'ready' : 'pending'
}

export function createStartupProjection(): StartupProjection {
  const stages = new Map<string, StartupStageSnapshot>()
  const listeners = new Set<(snapshot: StartupSnapshot) => void>()
  let revision = 0
  let current: StartupSnapshot = {
    revision,
    phase: 'pending',
    running: [],
    stages: []
  }

  const publish = (): void => {
    const reports = [...stages.values()]
    revision += 1
    current = {
      revision,
      phase: phaseFor(reports),
      running: reports.filter((stage) => stage.status === 'running').map((stage) => stage.name),
      stages: reports
    }
    for (const listener of listeners) listener(current)
  }

  return {
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stageStarted: ({ name, required }) => {
      stages.set(name, { name, status: 'running', required })
      publish()
    },
    stageSettled: (stage) => {
      stages.set(stage.name, stage)
      publish()
    }
  }
}

export const startupProjection = createStartupProjection()
