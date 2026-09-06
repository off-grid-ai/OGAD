/**
 * Real Desktop model-lifecycle composition over the Shared routing and residency contracts. Only
 * the native model adapter and its route inventory port are controlled boundaries.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GenerationAdapter, RuntimeModel, WorkspaceLifecycleRouting } from '@offgrid/models'
import { desktopModelLifecyclePorts } from '../model-lifecycle'

const model: RuntimeModel = {
  id: 'gemma-local',
  routeId: 'local:gemma-local',
  name: 'Gemma Local',
  kind: 'text',
  modality: 'text',
  source: 'local',
  adapterId: 'native-llama',
  capabilities: {},
  residencyKey: 'llama-engine',
  dirtyMemory: true,
  residencyLifecycle: 'persistent',
  peakSizeMB: 2_048,
  installed: true,
  ready: true,
  loaded: true
}

describe('Desktop model lifecycle composition', () => {
  it('resolves one native route through load, unload, selection, and inventory refresh', async () => {
    const loaded: RuntimeModel[] = []
    const unloaded: RuntimeModel[] = []
    const adapter: GenerationAdapter = {
      id: 'native-llama',
      load: async (selected) => {
        loaded.push(selected)
      },
      unload: async (selected) => {
        unloaded.push(selected)
      },
      generate: async function* () {}
    }
    const select = vi.fn<WorkspaceLifecycleRouting['select']>()
    const refresh = vi.fn<WorkspaceLifecycleRouting['refresh']>().mockResolvedValue([model])
    const routing: WorkspaceLifecycleRouting = {
      lookup: (identifier) => (identifier === model.routeId ? model : null),
      active: (modality) => ({
        modality,
        selectedId: model.id,
        selectedRouteId: model.routeId ?? null,
        model: modality === 'text' ? model : null,
        // shared 59f0862 separates install from runtime readiness on the active snapshot.
        ready: modality === 'text'
      }),
      select,
      refresh
    }
    const ports = desktopModelLifecyclePorts(new Map([[adapter.id, adapter]]), routing)

    // shared 48adf0b: resolveLoad carries the load command and may settle asynchronously.
    const load = await ports.resolveLoad('text', 'local:gemma-local', { override: false })
    expect(load).toMatchObject({
      routeId: 'local:gemma-local',
      spec: {
        key: 'text:local:gemma-local',
        modelId: 'local:gemma-local',
        type: 'text',
        sizeMB: 2_048,
        dirtyMemory: true,
        residencyKey: 'llama-engine',
        lifecycle: 'persistent'
      }
    })
    await load.handlers.load()
    await expect(load.handlers.unload()).resolves.toEqual({ reclaimed: true })
    expect(loaded).toEqual([model])
    expect(unloaded).toEqual([model])

    const unload = await ports.resolveUnload('text')
    expect(unload).toMatchObject({ key: 'text:local:gemma-local', hadRuntime: true })
    await expect(unload.unload()).resolves.toEqual({ reclaimed: true })
    const inactive = await ports.resolveUnload('voice')
    expect(inactive).toMatchObject({ key: 'voice:inactive', hadRuntime: false })
    await expect(inactive.unload()).resolves.toEqual({ reclaimed: true })

    await ports.selectRoute('text', 'local:gemma-local')
    await ports.refreshInventory()
    expect(select).toHaveBeenCalledWith('text', 'local:gemma-local')
    expect(refresh).toHaveBeenCalledOnce()
    expect(unloaded).toEqual([model, model])
  })

  it('fails closed when an identifier or native lifecycle adapter is unavailable', () => {
    const routing: WorkspaceLifecycleRouting = {
      lookup: () => null,
      active: (modality) => ({
        modality,
        selectedId: null,
        selectedRouteId: null,
        model: null,
        ready: false
      }),
      select: async () => undefined,
      refresh: async () => []
    }
    expect(() =>
      desktopModelLifecyclePorts(new Map(), routing).resolveLoad('text', 'missing', { override: false })
    ).toThrow('No local text model matches missing.')

    const knownRouting = { ...routing, lookup: () => model }
    expect(() =>
      desktopModelLifecyclePorts(new Map(), knownRouting).resolveLoad('text', model.id, {
        override: false
      })
    ).toThrow('Model lifecycle adapter is unavailable: native-llama.')
  })
})
