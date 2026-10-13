import type { ActionRecord, ExecuteResult } from '@offgrid/use'
import { getComputerUseSettings } from '../computer-use-settings'
import { getWebUseSettings } from '../web-use-settings'
import {
  getActiveRemoteVisionServer,
  getRemoteVisionServerForModel
} from '../vision/remote-vision-server'
import { selectedGrounderModelId } from '../vision/grounder-loader'
import { selectedDecisionModelId } from '../accessibility/decision-model-loader'
import { remoteScreenDecision, type ScreenTaskKind } from '../../shared/remote-screen-privacy'
import {
  createComputerUseRunTelemetry,
  finishComputerUseRunTelemetry,
  runWithRemoteScreenTaskSession
} from './remote-screen-session'
import type { ComputerUseModelStrategy } from '../../shared/computer-use-settings'

interface RemoteScreenGateDependencies {
  modelStrategy(taskKind: ScreenTaskKind): ComputerUseModelStrategy
  activeServer(): ReturnType<typeof getActiveRemoteVisionServer>
  specialistServer?(): ReturnType<typeof getActiveRemoteVisionServer>
  decisionServer?(taskKind: ScreenTaskKind): ReturnType<typeof getActiveRemoteVisionServer>
}

const productionDependencies: RemoteScreenGateDependencies = {
  modelStrategy: (taskKind) =>
    taskKind === 'web_use'
      ? getWebUseSettings().modelStrategy
      : getComputerUseSettings().modelStrategy,
  activeServer: getActiveRemoteVisionServer,
  specialistServer: () => getRemoteVisionServerForModel(selectedGrounderModelId(), 'grounding'),
  decisionServer: (taskKind) => {
    const settings = taskKind === 'web_use' ? getWebUseSettings() : getComputerUseSettings()
    return getRemoteVisionServerForModel(
      settings.decisionModelId ?? selectedDecisionModelId(),
      'decision'
    )
  }
}

/** The task a screen gate guards, as audit and telemetry name it. */
export interface ScreenTaskIdentity {
  readonly id: string
  readonly goal: string
}

/** Stop a screen task before its host captures or sends the first frame. */
export function withRemoteScreenGate(
  taskKind: ScreenTaskKind,
  execute: (action: ActionRecord) => Promise<ExecuteResult>,
  dependencies: RemoteScreenGateDependencies = productionDependencies
): (action: ActionRecord) => Promise<ExecuteResult> {
  return (action) => {
    const goal = (action.args as Record<string, unknown>).goal
    return runInRemoteScreenGate(
      taskKind,
      { id: action.id, goal: typeof goal === 'string' ? goal : action.intent },
      () => execute(action),
      { outcome: (result) => result, refused: (detail) => ({ ok: false, detail }) },
      dependencies
    )
  }
}

/** Run one screen task inside the gate: the privacy decision, the task kind's own model
 *  settings for every rail, and run telemetry. New tasks and retries both enter here, so a
 *  Continue uses the same Web Use or Computer Use selection as the run it continues. */
export async function runInRemoteScreenGate<T>(
  taskKind: ScreenTaskKind,
  task: ScreenTaskIdentity,
  run: () => Promise<T>,
  result: { outcome(value: T): ExecuteResult; refused(detail: string | undefined): T },
  dependencies: RemoteScreenGateDependencies = productionDependencies
): Promise<T> {
  const modelStrategy = dependencies.modelStrategy(taskKind)
  const activeServer = dependencies.activeServer()
  const specialistServer = dependencies.specialistServer?.() ?? null
  const decisionServer = dependencies.decisionServer?.(taskKind) ?? null
  const activeServers = [
    ...(modelStrategy === 'same_as_chat' ||
    modelStrategy === 'text_plus_specialist' ||
    modelStrategy === 'decision_plus_reasoning'
      ? [activeServer]
      : []),
    ...(modelStrategy === 'separate_specialist' ||
    modelStrategy === 'text_plus_specialist' ||
    modelStrategy === 'decision_plus_specialist'
      ? [specialistServer]
      : [])
  ].filter((server): server is NonNullable<typeof server> => server !== null)
  const decision = remoteScreenDecision({
    taskKind,
    modelStrategy,
    activeServer,
    activeServers
  })
  if (!decision.allowed) return result.refused(decision.message)
  const telemetry =
    taskKind === 'computer_use'
      ? createComputerUseRunTelemetry({
          actionId: task.id,
          task: task.goal,
          strategy: modelStrategy,
          reasoningServer: activeServer,
          groundingServer: specialistServer,
          deciderServer: decisionServer
        })
      : undefined
  try {
    const value = await runWithRemoteScreenTaskSession(
      { taskKind, modelStrategy, activeServer, telemetry },
      run
    )
    if (telemetry) await finishComputerUseRunTelemetry(telemetry, result.outcome(value))
    return value
  } catch (error) {
    if (telemetry) {
      await finishComputerUseRunTelemetry(telemetry, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      })
    }
    throw error
  }
}
