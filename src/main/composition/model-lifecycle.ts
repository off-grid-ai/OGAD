import {
  runtimeModelRouteId,
  type GenerationAdapter,
  type ModelLifecycleApplicationPorts,
  type ModelModality,
  type WorkspaceLifecycleRouting,
  reclaimAttempt,
  type RuntimeModel
} from '@offgrid/models'

function localModel(
  routing: WorkspaceLifecycleRouting,
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
  routing: WorkspaceLifecycleRouting
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
      const active = routing.active(modality).model
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
    refreshInventory: async () => {
      await routing.refresh()
    }
  }
}
