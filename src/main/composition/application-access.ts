import type { ModelsFacade, ModelsFailure, OffGridApplication } from '@offgrid/application'

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

/** Temporary legacy result projection. New consumers render the typed failure directly. */
export function modelsFailureMessage(failure: ModelsFailure): string {
  switch (failure.kind) {
    case 'unknown_model':
      return `Unknown model: ${failure.identifier}`
    case 'not_ready':
    case 'memory_refused':
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
