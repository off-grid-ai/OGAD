import type { ModelsFacade, ModelsFailure, Outcome } from '@offgrid/application'
import type { ActiveModelSnapshot } from '@offgrid/models'

export type StartupTextModelState =
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'prepared'; readonly active: ActiveModelSnapshot }

/** Startup warms an existing selection; a new profile has no selection to prepare. */
export async function prepareStartupTextModel(
  models: Pick<ModelsFacade, 'refresh' | 'snapshot' | 'prepare'>,
  operationId?: string
): Promise<Outcome<StartupTextModelState, ModelsFailure>> {
  const refreshed = await models.refresh()
  if (!refreshed.ok) return refreshed
  const active = models.snapshot().active.text
  if (!active) {
    return {
      ok: false,
      failure: { kind: 'runtime', message: 'The refreshed text model state is unavailable.' }
    }
  }
  // Test explicit nulls, not truthiness. A malformed persisted ID or an offline selected
  // route must reach prepare and retain its failure, not masquerade as a fresh profile.
  if (active.selectedId === null && active.selectedRouteId === null && active.model === null) {
    return { ok: true, value: { kind: 'unconfigured' } }
  }
  const prepared = await models.prepare('text', { operationId })
  return prepared.ok ? { ok: true, value: { kind: 'prepared', active: prepared.value } } : prepared
}
