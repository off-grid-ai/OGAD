import type { RemoteVisionProvider, RemoteVisionSavedServer } from './remote-vision-server'

export type ScreenTaskKind = 'web_use' | 'computer_use'

export interface RemoteScreenDecision {
  allowed: boolean
  remote: boolean
  serverName?: string
  destination?: string
  message?: string
}

function destinationFor(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

export function providerNeedsScreenDisclosure(provider: RemoteVisionProvider): boolean {
  return provider === 'openrouter' || provider === 'custom'
}

/**
 * One decision for settings copy and both screen-task runtimes. A separate
 * specialist is local, so the active remote Chat model does not receive frames.
 */
export function remoteScreenDecision(input: {
  taskKind: ScreenTaskKind
  modelStrategy: 'same_as_chat' | 'separate_specialist' | 'text_plus_specialist'
  activeServer: Pick<
    RemoteVisionSavedServer,
    'name' | 'provider' | 'endpoint' | 'screenFramesAllowed'
  > | null
}): RemoteScreenDecision {
  const { activeServer } = input
  if (
    input.modelStrategy === 'separate_specialist' ||
    !activeServer ||
    !providerNeedsScreenDisclosure(activeServer.provider)
  ) {
    return { allowed: true, remote: false }
  }

  const destination = destinationFor(activeServer.endpoint)
  if (activeServer.screenFramesAllowed) {
    return {
      allowed: true,
      remote: true,
      serverName: activeServer.name,
      destination
    }
  }

  const feature = input.taskKind === 'web_use' ? 'Web Use' : 'Computer Use'
  return {
    allowed: false,
    remote: true,
    serverName: activeServer.name,
    destination,
    message: `${feature} did not send your screen. ${activeServer.name} at ${destination} is a remote model server. Open Settings > Remote, review the screen-image disclosure, and allow screen images before you try again.`
  }
}
