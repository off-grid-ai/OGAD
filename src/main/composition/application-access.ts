import type {
  ModelsFacade,
  ModelsFailure,
  OffGridApplication,
  PartialGenerationState
} from '@offgrid/application'
import type {
  GenerationEvents,
  GenerationLifecycleEvent,
  GenerationRequest,
  GenerationResult,
  ModelModality
} from '@offgrid/models'

let application: OffGridApplication | null = null

export function registerDesktopApplication(value: OffGridApplication): void {
  application = value
}

function current(): OffGridApplication {
  if (!application) throw new Error('Desktop application is not initialized.')
  return application
}

/** Stable access to the Shared Models facade without a composition-root import cycle. */
export const desktopModels: ModelsFacade = new Proxy({} as ModelsFacade, {
  get: (_target, property) => {
    const facade = current().models
    const value = facade[property as keyof ModelsFacade]
    return typeof value === 'function' ? value.bind(facade) : value
  }
})

export function modelsFailureMessage(failure: ModelsFailure): string {
  switch (failure.kind) {
    case 'unknown_model':
      return `Unknown model: ${failure.identifier}`
    case 'not_ready':
    case 'unsupported_capability':
    case 'memory_refused':
    case 'timeout':
      return failure.reason
    case 'remote_http':
      return failure.reason ?? `The remote model returned HTTP ${failure.status}.`
    case 'context_full':
      return 'The model context is full.'
    case 'cancelled':
      return 'The model operation was cancelled.'
    case 'runtime':
      return failure.message
  }
}

export class DesktopModelsOperationError extends Error {
  constructor(
    readonly failure: ModelsFailure,
    readonly partial?: PartialGenerationState
  ) {
    super(modelsFailureMessage(failure))
    this.name = 'DesktopModelsOperationError'
  }
}

export async function selectDesktopModel(
  modality: ModelModality,
  modelId: string | null
): Promise<{ success: boolean; error?: string }> {
  const outcome = await desktopModels.select({ modality, modelId })
  return outcome.ok
    ? { success: true }
    : { success: false, error: modelsFailureMessage(outcome.failure) }
}

export async function unloadDesktopModel(
  modality: ModelModality,
  keepSelection = false
): Promise<boolean> {
  const outcome = await desktopModels.unload({ modality, keepSelection })
  if (!outcome.ok) throw new DesktopModelsOperationError(outcome.failure)
  return outcome.value
}

export function desktopActiveModalities(): {
  text: string | null
  computer_use: string | null
  image: string | null
  speech: string | null
  transcription: string | null
} {
  return {
    text: desktopModels.activeModelId('text'),
    computer_use: desktopModels.activeModelId('computer_use'),
    image: desktopModels.activeModelId('image'),
    speech: desktopModels.activeModelId('voice'),
    transcription: desktopModels.activeModelId('transcription')
  }
}

function publishLifecycle(event: GenerationLifecycleEvent, target: GenerationEvents): void {
  switch (event.type) {
    case 'route':
      target.route?.(event.model)
      break
    case 'fallback':
      target.fallback?.(event.failed, event.next, event.error)
      break
    case 'partial_discarded':
      target.partialDiscarded?.(event.model)
      break
    case 'tool_started':
      target.toolStarted?.(event.call)
      break
    case 'tool_completed':
      target.toolCompleted?.(event.call, event.result)
      break
    case 'vision_recovery':
      target.visionRecovery?.(event.model, event.note)
      break
  }
}

/** Consume the typed Models stream for Desktop services that need one final result. */
export async function generateWithDesktopModels(
  request: GenerationRequest,
  events: GenerationEvents = {}
): Promise<GenerationResult> {
  let result: GenerationResult | null = null
  for await (const event of desktopModels.generate({ request })) {
    if (event.type === 'chunk') events.chunk?.(event.chunk)
    else if (event.type === 'lifecycle') publishLifecycle(event.event, events)
    else if (event.type === 'message') events.message?.(event.message)
    else if (event.type === 'failed') {
      throw new DesktopModelsOperationError(event.failure, event.partial)
    } else result = event.result
  }
  if (!result) {
    throw new DesktopModelsOperationError({
      kind: 'runtime',
      message: 'The model operation ended without a result.'
    })
  }
  return result
}
