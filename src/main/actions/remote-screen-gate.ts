import type { ActionRecord, ExecuteResult } from '@offgrid/use'
import { getComputerUseSettings } from '../computer-use-settings'
import { desktopModels } from '../composition/application-access'
import { getSelectedRemoteVisionServer } from '../vision/remote-vision-server'
import { remoteScreenDecision, type ScreenTaskKind } from '../../shared/remote-screen-privacy'
import { runWithRemoteScreenTaskSession } from './remote-screen-session'

interface RemoteScreenGateDependencies {
  modelStrategy(): 'same_as_chat' | 'separate_specialist' | 'text_plus_specialist'
  activeServer(): ReturnType<typeof getSelectedRemoteVisionServer>
  /** Has the person chosen any model for this task? Absent counts as nothing chosen. */
  anyModelChosen?(): boolean
}

const productionDependencies: RemoteScreenGateDependencies = {
  modelStrategy: () => getComputerUseSettings().modelStrategy,
  // The chat modality is what a screen task sends a frame to.
  activeServer: () => getSelectedRemoteVisionServer('text'),
  // A model running on this device answers yes here, which is what lets a local run through.
  anyModelChosen: () => desktopModels.activeModelId('text') !== null
}

/** Stop a screen task before its host captures or sends the first frame. */
export function withRemoteScreenGate(
  taskKind: ScreenTaskKind,
  execute: (action: ActionRecord) => Promise<ExecuteResult>,
  dependencies: RemoteScreenGateDependencies = productionDependencies
): (action: ActionRecord) => Promise<ExecuteResult> {
  return async (action) => {
    const modelStrategy = dependencies.modelStrategy()
    const activeServer = dependencies.activeServer()
    const decision = remoteScreenDecision({
      taskKind,
      modelStrategy,
      activeServer,
      anyModelChosen: dependencies.anyModelChosen?.()
    })
    if (!decision.allowed) return { ok: false, detail: decision.message }
    return runWithRemoteScreenTaskSession({ taskKind, modelStrategy, activeServer }, () =>
      execute(action)
    )
  }
}
