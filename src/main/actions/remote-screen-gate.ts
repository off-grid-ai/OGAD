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
import { runWithRemoteScreenTaskSession } from './remote-screen-session'
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
  specialistServer: () => getRemoteVisionServerForModel(selectedGrounderModelId()),
  decisionServer: (taskKind) => {
    const settings = taskKind === 'web_use' ? getWebUseSettings() : getComputerUseSettings()
    return getRemoteVisionServerForModel(settings.decisionModelId ?? selectedDecisionModelId())
  }
}

/** Stop a screen task before its host captures or sends the first frame. */
export function withRemoteScreenGate(
  taskKind: ScreenTaskKind,
  execute: (action: ActionRecord) => Promise<ExecuteResult>,
  dependencies: RemoteScreenGateDependencies = productionDependencies
): (action: ActionRecord) => Promise<ExecuteResult> {
  return async (action) => {
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
        : []),
      ...(modelStrategy === 'decision_plus_specialist' ||
      modelStrategy === 'decision_plus_reasoning'
        ? [decisionServer]
        : [])
    ].filter((server): server is NonNullable<typeof server> => server !== null)
    const decision = remoteScreenDecision({
      taskKind,
      modelStrategy,
      activeServer,
      activeServers
    })
    if (!decision.allowed) return { ok: false, detail: decision.message }
    return runWithRemoteScreenTaskSession({ taskKind, modelStrategy, activeServer }, () =>
      execute(action)
    )
  }
}
