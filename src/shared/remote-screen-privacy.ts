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
    'name' | 'provider' | 'endpoint' | 'screenFramesAllowed' | 'enabled'
  > | null
  /** Whether the person has chosen any model for this task. Absent counts as nothing chosen. */
  anyModelChosen?: boolean
}): RemoteScreenDecision {
  const { activeServer } = input
  const feature = input.taskKind === 'web_use' ? 'Web Use' : 'Computer Use'
  // No chosen server means two different things, and only one is safe to run: a model on this
  // device, or nothing chosen yet. Absent counts as nothing chosen, so a caller that cannot answer
  // gets the careful answer instead of a silent run.
  if (!activeServer && input.anyModelChosen !== true) {
    return {
      allowed: false,
      remote: false,
      message: `${feature} did not run. No model is chosen for it yet. Open Settings > Models and choose a model, then try again.`
    }
  }
  // A saved choice can outlive the switch: the person turned this server off but the choice still
  // points at it. Running anyway would send a screen image to a server they have disabled, so the
  // refusal names it - naming is only possible because the choice is still known here.
  if (activeServer && activeServer.enabled === false) {
    return {
      allowed: false,
      remote: false,
      serverName: activeServer.name,
      message: `${feature} did not run. ${activeServer.name} is switched off. Open Settings > Remote and switch it on, or choose a server that is on, then try again.`
    }
  }
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

  return {
    allowed: false,
    remote: true,
    serverName: activeServer.name,
    destination,
    message: `${feature} did not send your screen. ${activeServer.name} at ${destination} is a remote model server. Open Settings > Remote, review the screen-image disclosure, and allow screen images before you try again.`
  }
}
