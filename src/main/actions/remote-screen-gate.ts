import type { ActionRecord, ExecuteResult } from '@offgrid/use'
import { getComputerUseSettings } from '../computer-use-settings'
import { getActiveRemoteVisionServer } from '../vision/remote-vision-server'
import { remoteScreenDecision, type ScreenTaskKind } from '../../shared/remote-screen-privacy'
import { runWithRemoteScreenTaskSession } from './remote-screen-session'

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
    const modelStrategy = dependencies.modelStrategy()
    const activeServer = dependencies.activeServer()
    const decision = remoteScreenDecision({
      taskKind,
      modelStrategy,
      activeServer
    })
    if (!decision.allowed) return { ok: false, detail: decision.message }
    return runWithRemoteScreenTaskSession({ taskKind, modelStrategy, activeServer }, () =>
      execute(action)
    )
  }
}
