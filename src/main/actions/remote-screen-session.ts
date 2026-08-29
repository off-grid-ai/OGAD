import { AsyncLocalStorage } from 'node:async_hooks'
import type { ComputerUseModelStrategy } from '../../shared/computer-use-settings'
import type { ScreenTaskKind } from '../../shared/remote-screen-privacy'
import type { getActiveRemoteVisionServer } from '../vision/remote-vision-server'

export interface RemoteScreenTaskSession {
  taskKind: ScreenTaskKind
  modelStrategy: ComputerUseModelStrategy
  activeServer: ReturnType<typeof getActiveRemoteVisionServer>
}

const sessions = new AsyncLocalStorage<Readonly<RemoteScreenTaskSession>>()

/** Bind privacy, model selection, and remote transport to one task-start snapshot. */
export function runWithRemoteScreenTaskSession<T>(
  session: RemoteScreenTaskSession,
  task: () => Promise<T>
): Promise<T> {
  const activeServer = session.activeServer ? Object.freeze({ ...session.activeServer }) : null
  return sessions.run(Object.freeze({ ...session, activeServer }), task)
}

export function currentRemoteScreenTaskSession(): Readonly<RemoteScreenTaskSession> | undefined {
  return sessions.getStore()
}
