import {
  runtimeModelRouteId,
  type GenerationAdapter,
  type ModelLifecycleApplicationPorts,
  type ModelModality,
  type ModelWorkspace,
  type RuntimeModel
} from '@offgrid/models'

function localModel(
  workspace: ModelWorkspace,
  modality: ModelModality,
  identifier: string
): RuntimeModel {
  const model = workspace.lookup(identifier)
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

/** Desktop supplies native lifecycle I/O. Shared owns admission, selection, and transactions. */
export function desktopModelLifecyclePorts(
  workspace: ModelWorkspace,
  adapters: ReadonlyMap<string, GenerationAdapter>
): ModelLifecycleApplicationPorts {
  return {
    resolveLoad(modality, identifier) {
      const model = localModel(workspace, modality, identifier)
      const adapter = lifecycleAdapter(adapters, model)
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
          unload: () => adapter.unload(model)
        }
      }
    },
    resolveUnload(modality) {
      const active = workspace.active(modality).model
      if (!active || active.source !== 'local') {
        return { key: `${modality}:inactive`, hadRuntime: false, unload: async () => undefined }
      }
      const adapter = lifecycleAdapter(adapters, active)
      return {
        key: `${modality}:${routeId(active)}`,
        hadRuntime: active.loaded,
        unload: () => adapter.unload(active)
      }
    },
    selectRoute: (modality, selectedRoute) => workspace.select(modality, selectedRoute),
    refreshInventory: () => workspace.refresh().then(() => undefined)
  }
}
