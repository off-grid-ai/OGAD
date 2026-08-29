import type { ActionRecord, ExecuteResult } from '@offgrid/use'
import { getComputerUseSettings } from '../computer-use-settings'
import { getActiveRemoteVisionServer } from '../vision/remote-vision-server'
import { remoteScreenDecision, type ScreenTaskKind } from '../../shared/remote-screen-privacy'

interface RemoteScreenGateDependencies {
  modelStrategy(): 'same_as_chat' | 'separate_specialist' | 'text_plus_specialist'
  activeServer(): ReturnType<typeof getActiveRemoteVisionServer>
}

const productionDependencies: RemoteScreenGateDependencies = {
  modelStrategy: () => getComputerUseSettings().modelStrategy,
  activeServer: getActiveRemoteVisionServer
}

/** Stop a screen task before its host captures or sends the first frame. */
export function withRemoteScreenGate(
  taskKind: ScreenTaskKind,
  execute: (action: ActionRecord) => Promise<ExecuteResult>,
  dependencies: RemoteScreenGateDependencies = productionDependencies
): (action: ActionRecord) => Promise<ExecuteResult> {
  return async (action) => {
    const decision = remoteScreenDecision({
      taskKind,
      modelStrategy: dependencies.modelStrategy(),
      activeServer: dependencies.activeServer()
    })
    if (!decision.allowed) return { ok: false, detail: decision.message }
    return execute(action)
  }
}
