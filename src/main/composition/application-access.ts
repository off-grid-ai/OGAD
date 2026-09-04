import {
  modelsFailureMessage,
  type ApplicationDegradation,
  type ModelsFailure,
  type AutomationFacade,
  type GenerationEvents,
  type GenerationLifecycleEvent,
  type GenerationRequest,
  type GenerationResult,
  type ModelModality,
  type ModelsFacade,
  type OffGridApplication,
  type OffGridApplicationSnapshot,
  type OffGridDomain,
  type PartialGenerationState,
  type RagFacade,
  type SyncFacade,
  type Unsubscribe,
  type UseFacade
} from '@offgrid/application'

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

/** Stable access to the Shared RAG facade without a composition-root import cycle. */
export const desktopRag: RagFacade = new Proxy({} as RagFacade, {
  get: (_target, property) => {
    const facade = current().rag
    const value = facade[property as keyof RagFacade]
    return typeof value === 'function' ? value.bind(facade) : value
  }
})

/** Stable access to the Shared Automation facade without a composition-root import cycle. */
export const desktopAutomation: AutomationFacade = new Proxy({} as AutomationFacade, {
  get: (_target, property) => {
    const facade = current().automation
    const value = facade[property as keyof AutomationFacade]
    return typeof value === 'function' ? value.bind(facade) : value
  }
})

/** Stable access to the Shared Use facade without a composition-root import cycle. */
export const desktopUse: UseFacade = new Proxy({} as UseFacade, {
  get: (_target, property) => {
    const facade = current().use
    const value = facade[property as keyof UseFacade]
    return typeof value === 'function' ? value.bind(facade) : value
  }
})

/**
 * The one call an owner that activates BESIDE the application root makes about its own health:
 * Pro's Sync activation is the case today. Shared retains the report on its snapshot, so a
 * surface that subscribes long after boot still sees it. `reason: null` clears this owner's
 * entry and no other owner's.
 */
export function reportDesktopApplicationDegraded(entry: {
  readonly domain: OffGridDomain
  readonly source: string
  readonly reason: string | null
}): void {
  current().reportDegraded(entry)
}

/** What one owner currently reports about one domain, read from the shared snapshot. */
export function desktopApplicationDegradation(
  domain: OffGridDomain,
  source: string
): ApplicationDegradation | null {
  return findDegradation(current().snapshot(), domain, source)
}

/** The same query over a snapshot a consumer already holds. Pure. */
export function findDegradation(
  snapshot: Pick<OffGridApplicationSnapshot, 'degraded'>,
  domain: OffGridDomain,
  source: string
): ApplicationDegradation | null {
  return (
    snapshot.degraded.find((entry) => entry.domain === domain && entry.source === source) ?? null
  )
}

/**
 * Watch ONE owner's report about ONE domain. The application snapshot moves for every domain
 * event; this notifies only when the reason for this pair actually changes, so a consumer that
 * repaints on degradation does not repaint on unrelated domain traffic.
 */
export function observeDesktopApplicationDegradation(
  domain: OffGridDomain,
  source: string,
  listener: (degradation: ApplicationDegradation | null) => void
): Unsubscribe {
  let last = desktopApplicationDegradation(domain, source)
  return current().subscribe((snapshot) => {
    const next = findDegradation(snapshot, domain, source)
    if (next === last) return
    last = next
    listener(next)
  })
}

/** Stable access to the Shared Sync facade without constructing the application root. */
export const desktopSync: SyncFacade = new Proxy({} as SyncFacade, {
  get: (_target, property) => {
    const facade = current().sync
    const value = facade[property as keyof SyncFacade]
    return typeof value === 'function' ? value.bind(facade) : value
  }
})

export { modelsFailureMessage }

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
