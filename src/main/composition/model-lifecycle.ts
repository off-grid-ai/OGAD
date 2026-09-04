import {
  runtimeModelRouteId,
  type GenerationAdapter,
  type ModelLifecycleApplicationPorts,
  type ModelModality,
  reclaimAttempt,
  type RuntimeModel
} from '@offgrid/models'
import {
  DesktopModelsOperationError,
  desktopModels,
  refreshDesktopModels
} from './application-access'

/**
 * The only model routing these ports need. It used to be the desktop `ModelWorkspace` INSTANCE,
 * which made this module's caller (`model-services.ts`) an app-level workspace owner. Shared's root
 * now composes the single workspace from platform ports, and the platform contract cannot accept a
 * workspace instance. A held app instance would therefore be a second routing and residency owner.
 *
 * None of the four capabilities is residency: they are all routing, and each has a facade
 * equivalent. This narrow shape also keeps the module unit-testable without a workspace or the
 * application root.
 */
export interface DesktopModelLifecycleRouting {
  /** The inventory model any identifier names, or null. */
  lookup(identifier: string): RuntimeModel | null
  /** The model currently answering a modality, or null when nothing is selected or resolvable. */
  activeModel(modality: ModelModality): RuntimeModel | null
  select(modality: ModelModality, selectedRoute: string | null): Promise<void>
  refresh(): Promise<void>
}

/**
 * Facade-backed routing, the pattern `speech-selection.ts` established for the same reason.
 * `snapshot().active[modality]` is the very `ActiveModelSnapshot` the workspace's `active()`
 * returned - shared republishes that branch synchronously from the routing owner's own
 * subscription, so a read straight after a selection sees the selection.
 */
const facadeRouting: DesktopModelLifecycleRouting = {
  lookup: (identifier) => desktopModels.lookup(identifier),
  activeModel: (modality) => desktopModels.snapshot().active[modality]?.model ?? null,
  async select(modality, selectedRoute) {
    const outcome = await desktopModels.select({ modality, modelId: selectedRoute })
    // Shared's lifecycle transaction compensates on a throw, so a typed failure must not become a
    // silent no-op selection while the load it belongs to reports success.
    if (!outcome.ok) throw new DesktopModelsOperationError(outcome.failure)
  },
  refresh: refreshDesktopModels
}

function localModel(
  routing: DesktopModelLifecycleRouting,
  modality: ModelModality,
  identifier: string
): RuntimeModel {
  const model = routing.lookup(identifier)
  if (!model || model.modality !== modality || model.source !== 'local') {
    throw new Error(`No local ${modality} model matches ${identifier}.`)
  }
  return model
}

function lifecycleAdapter(
  adapters: ReadonlyMap<string, GenerationAdapter>,
  model: RuntimeModel
): Required<Pick<GenerationAdapter, 'load' | 'unload'>> {
  const adapter = adapters.get(model.adapterId)
  if (!adapter?.load || !adapter.unload) {
    throw new Error(`Model lifecycle adapter is unavailable: ${model.adapterId}.`)
  }
  return { load: adapter.load.bind(adapter), unload: adapter.unload.bind(adapter) }
}

function routeId(model: RuntimeModel): string {
  return model.routeId ?? runtimeModelRouteId(model)
}

function computerUseLifecycle(
  modelId: string
): Required<Pick<GenerationAdapter, 'load' | 'unload'>> {
  return {
    async load() {
      const [{ loadComputerUseModel }, { llm }] = await Promise.all([
        import('../models-manager'),
        import('../llm')
      ])
      const projected = await loadComputerUseModel(modelId)
      if (!projected.success) {
        throw new Error(projected.error ?? 'The Computer Use model could not load.')
      }
      await llm.restart()
    },
    async unload() {
      await (await import('../llm')).llm.unload()
    }
  }
}

/** Desktop supplies native lifecycle I/O. Shared owns admission, selection, and transactions. */
export function desktopModelLifecyclePorts(
  adapters: ReadonlyMap<string, GenerationAdapter>,
  routing: DesktopModelLifecycleRouting = facadeRouting
): ModelLifecycleApplicationPorts {
  return {
    resolveLoad(modality, identifier) {
      const model = localModel(routing, modality, identifier)
      const adapter =
        modality === 'computer_use'
          ? computerUseLifecycle(model.id)
          : lifecycleAdapter(adapters, model)
      const id = routeId(model)
      return {
        routeId: id,
        spec: {
          key: `${modality}:${id}`,
          modelId: id,
          type: modality,
          sizeMB: model.peakSizeMB ?? model.residentSizeMB ?? 0,
          dirtyMemory: model.dirtyMemory,
          residencyKey: model.residencyKey,
          lifecycle: model.residencyLifecycle ?? 'persistent'
        },
        handlers: {
          load: () => adapter.load(model),
          unload: () => reclaimAttempt(() => adapter.unload(model))
        }
      }
    },
    resolveUnload(modality) {
      const active = routing.activeModel(modality)
      if (!active || active.source !== 'local') {
        // No runtime, so nothing held memory: a true reclaim, not an unknown one. `hadRuntime`
        // still says a runtime never existed, which is a different fact from whether memory came
        // back.
        return {
          key: `${modality}:inactive`,
          hadRuntime: false,
          unload: async () => ({ reclaimed: true }) as const
        }
      }
      const adapter = lifecycleAdapter(adapters, active)
      return {
        key: `${modality}:${routeId(active)}`,
        hadRuntime: active.loaded,
        unload: () => reclaimAttempt(() => adapter.unload(active))
      }
    },
    selectRoute: (modality, selectedRoute) => routing.select(modality, selectedRoute),
    refreshInventory: () => routing.refresh()
  }
}
