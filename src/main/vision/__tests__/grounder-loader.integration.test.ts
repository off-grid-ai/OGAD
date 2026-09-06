import { describe, expect, it } from 'vitest'
import { createOffGridApplication } from '@offgrid/application'
import { runtimeModelRouteId, type ModelModality, type RuntimeModel } from '@offgrid/models'
import {
  createGrounderLifecycle,
  createGrounderRunner,
  type GrounderRunnerDependencies
} from '../grounder-loader'

const CHAT_MODEL = 'google/gemini-3.7-flash'
const SPECIALIST = 'tencent/UI-Mate-9B-GGUF'
const REMOTE = { id: 'openrouter', model: CHAT_MODEL }

function lifecycle(): {
  dependencies: GrounderRunnerDependencies
  events: string[]
  activeModelId(): string
  activeRemote(): { id: string; model: string } | null
} {
  const events: string[] = []
  let activeModel = { id: CHAT_MODEL, vision: true }
  let activeRemote: { id: string; model: string } | null = { ...REMOTE }
  return {
    events,
    activeModelId: () => activeModel.id,
    activeRemote: () => activeRemote,
    dependencies: {
      strategy: () => 'separate_specialist',
      selectedModelId: () => SPECIALIST,
      installed: async () => true,
      activeModel: () => activeModel,
      activeModelId: () => activeModel.id,
      activeRemote: () => activeRemote,
      isGrounder: (model) => model.id === SPECIALIST,
      load: async (modelId, nativeAlreadyLoaded) => {
        if (nativeAlreadyLoaded) return
        events.push(`load:${modelId}`)
        activeModel = { id: modelId, vision: true }
      },
      restoreLocal: async (modelId) => {
        events.push(`restore-local:${modelId}`)
        activeModel = { id: modelId, vision: true }
      },
      suspendRemote: () => {
        events.push('suspend-remote')
        activeRemote = null
      },
      restoreRemote: (selection) => {
        events.push(`restore-remote:${selection.model}`)
        activeRemote = selection
      }
    }
  }
}

describe('Computer Use specialist lifecycle', () => {
  it('uses shared selection and residency for the native specialist swap and restore', async () => {
    const selections = new Map<ModelModality, string | null>()
    const runtimeModels: RuntimeModel[] = [
      {
        id: CHAT_MODEL,
        name: 'Chat',
        kind: 'text',
        modality: 'text',
        source: 'local',
        adapterId: 'desktop.llama',
        capabilities: { textGeneration: true },
        installed: true,
        ready: false,
        loaded: false,
        residentSizeMB: 200,
        peakSizeMB: 240,
        residencyKey: 'desktop.llama'
      },
      {
        id: SPECIALIST,
        name: 'Grounder',
        kind: 'computer_use',
        modality: 'computer_use',
        source: 'local',
        adapterId: 'desktop.llama.computer-use',
        capabilities: { vision: true, computerUse: true },
        installed: true,
        ready: true,
        loaded: false,
        residentSizeMB: 300,
        peakSizeMB: 360,
        residencyKey: 'desktop.llama'
      }
    ]
    const events: string[] = []
    const loaded = new Set<string>()
    const inventory = {
      id: 'desktop-test-inventory',
      listModels: async () =>
        runtimeModels.map((model) => {
          const routeId = runtimeModelRouteId(model)
          return { ...model, ready: loaded.has(routeId), loaded: loaded.has(routeId) }
        })
    }
    const modelFor = (identifier: string): RuntimeModel => {
      const model = runtimeModels.find(
        (candidate) => candidate.id === identifier || runtimeModelRouteId(candidate) === identifier
      )
      if (!model) throw new Error(`Unknown lifecycle model: ${identifier}`)
      return model
    }
    const unloadModel = async (model: RuntimeModel): Promise<{ reclaimed: true }> => {
      const routeId = runtimeModelRouteId(model)
      loaded.delete(routeId)
      events.push(model.modality === 'computer_use' ? 'unload-grounder' : 'unload-chat')
      return { reclaimed: true }
    }
    const application = createOffGridApplication({
      models: {
        selection: {
          read: (modality) => selections.get(modality) ?? null,
          write: (modality, routeId) => {
            selections.set(modality, routeId)
          }
        },
        memory: {
          current: () => ({ totalMB: 16_384, availableMB: 16_384, platform: 'desktop' })
        },
        remote: {
          configuration: {
            read: () => ({ version: 1, activeServerId: null, servers: [] }),
            write: async () => undefined
          },
          credentials: {
            read: async () => null,
            write: async () => undefined,
            remove: async () => undefined
          },
          providers: {
            register: async () => undefined,
            unregister: async () => undefined
          }
        },
        inventoryAdapters: [inventory],
        lifecycle: () => ({
          resolveLoad(modality, identifier) {
            const model = modelFor(identifier)
            const routeId = runtimeModelRouteId(model)
            return {
              routeId,
              spec: {
                key: `${modality}:${routeId}`,
                modelId: routeId,
                type: modality,
                sizeMB: model.peakSizeMB ?? 0,
                residencyKey: model.residencyKey
              },
              handlers: {
                load: async () => {
                  loaded.add(routeId)
                  if (modality === 'computer_use') {
                    events.push(`project:${model.id}`)
                    events.push('restart-grounder')
                  } else {
                    events.push('load-chat')
                  }
                },
                unload: () => unloadModel(model)
              }
            }
          },
          resolveUnload(modality) {
            const model = application.models.snapshot().active[modality]?.model
            if (!model) {
              return {
                key: `${modality}:inactive`,
                hadRuntime: false,
                unload: async () => ({ reclaimed: true }) as const
              }
            }
            return {
              key: `${modality}:${runtimeModelRouteId(model)}`,
              hadRuntime: true,
              unload: () => unloadModel(model)
            }
          },
          async selectRoute(modality, routeId) {
            const selected = await application.models.select({ modality, modelId: routeId })
            if (!selected.ok) throw new Error(selected.failure.kind)
          },
          async refreshInventory() {
            const refreshed = await application.models.refresh()
            if (!refreshed.ok) throw new Error(refreshed.failure.kind)
          }
        })
      }
    })

    try {
      await application.start()
      await application.models.refresh()
      const chatRoute = runtimeModelRouteId(runtimeModels[0]!)
      expect(
        await application.models.select({ modality: 'text', modelId: chatRoute })
      ).toMatchObject({ ok: true })
      expect(await application.models.load({ modality: 'text', modelId: chatRoute })).toMatchObject(
        { ok: true }
      )
      const lifecycle = createGrounderLifecycle(application.models)

      await lifecycle.load(SPECIALIST)

      expect(application.models.snapshot().active.computer_use?.model?.id).toBe(SPECIALIST)
      expect(application.models.snapshot().residents.map((resident) => resident.type)).toEqual([
        'computer_use'
      ])
      expect(events).toEqual([
        'load-chat',
        'unload-chat',
        `project:${SPECIALIST}`,
        'restart-grounder'
      ])

      await lifecycle.restoreLocal(CHAT_MODEL)

      expect(application.models.snapshot().active.text?.model?.id).toBe(CHAT_MODEL)
      expect(application.models.snapshot().residents.map((resident) => resident.type)).toEqual([
        'text'
      ])
      expect(events.slice(-2)).toEqual(['unload-grounder', 'load-chat'])
    } finally {
      await application.stop()
    }
  })

  it('keeps the specialist resident between actions when the text reasoner is remote', async () => {
    const h = lifecycle()
    const run = createGrounderRunner({
      ...h.dependencies,
      strategy: () => 'text_plus_specialist'
    })

    await run(async () => {
      h.events.push('ground-action')
      expect(h.activeModelId()).toBe(SPECIALIST)
    })

    expect(h.activeModelId()).toBe(SPECIALIST)
    expect(h.activeRemote()).toEqual(REMOTE)
    expect(h.events).toEqual([
      'suspend-remote',
      `load:${SPECIALIST}`,
      'ground-action',
      `restore-remote:${CHAT_MODEL}`
    ])

    await run(async () => {
      h.events.push('next-ground-action')
      expect(h.activeModelId()).toBe(SPECIALIST)
    })

    expect(h.events).toEqual([
      'suspend-remote',
      `load:${SPECIALIST}`,
      'ground-action',
      `restore-remote:${CHAT_MODEL}`,
      'suspend-remote',
      'next-ground-action',
      `restore-remote:${CHAT_MODEL}`
    ])
  })

  it('runs the task on the selected specialist and restores remote Gemini afterward', async () => {
    const h = lifecycle()
    const run = createGrounderRunner(h.dependencies)
    let taskModel = ''

    const output = await run(async () => {
      h.events.push('run')
      taskModel = h.activeModelId()
      expect(h.activeRemote()).toBeNull()
      return 'complete'
    })

    expect(output.result).toBe('complete')
    expect(taskModel).toBe(SPECIALIST)
    expect(h.activeModelId()).toBe(SPECIALIST)
    expect(h.activeRemote()).toEqual(REMOTE)
    expect(h.events).toEqual([
      'suspend-remote',
      `load:${SPECIALIST}`,
      'run',
      `restore-remote:${CHAT_MODEL}`
    ])
  })

  it('restores the remote reasoner and keeps the specialist resident when the task fails', async () => {
    const h = lifecycle()
    const run = createGrounderRunner(h.dependencies)

    await expect(
      run(async () => {
        h.events.push('run')
        throw new Error('browser task failed')
      })
    ).rejects.toThrow('browser task failed')

    expect(h.activeModelId()).toBe(SPECIALIST)
    expect(h.activeRemote()).toEqual(REMOTE)
    expect(h.events.at(-1)).toBe(`restore-remote:${CHAT_MODEL}`)
    expect(h.events).not.toContain(`restore-local:${CHAT_MODEL}`)
  })

  it('restores the remote reasoner and keeps the specialist resident when the task is aborted', async () => {
    const h = lifecycle()
    const run = createGrounderRunner(h.dependencies)
    const controller = new AbortController()

    await expect(
      run(async () => {
        h.events.push('run')
        controller.abort()
        controller.signal.throwIfAborted()
        return 'unreachable'
      })
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(h.activeModelId()).toBe(SPECIALIST)
    expect(h.activeRemote()).toEqual(REMOTE)
    expect(h.events.at(-1)).toBe(`restore-remote:${CHAT_MODEL}`)
    expect(h.events).not.toContain(`restore-local:${CHAT_MODEL}`)
  })

  it('restores the local chat model when no remote reasoner exists', async () => {
    const h = lifecycle()
    const run = createGrounderRunner({
      ...h.dependencies,
      activeRemote: () => null
    })

    await run(async () => {
      h.events.push('run')
    })

    expect(h.activeModelId()).toBe(CHAT_MODEL)
    expect(h.events).toEqual([`load:${SPECIALIST}`, 'run', `restore-local:${CHAT_MODEL}`])
  })

  it('suspends remote priority even when the selected specialist is already resident', async () => {
    const h = lifecycle()
    const dependencies: GrounderRunnerDependencies = {
      ...h.dependencies,
      activeModel: () => ({ id: SPECIALIST, vision: true }),
      activeModelId: () => SPECIALIST
    }
    const run = createGrounderRunner(dependencies)

    await run(async () => {
      h.events.push('run')
      expect(h.activeRemote()).toBeNull()
    })

    expect(h.events).toEqual(['suspend-remote', 'run', `restore-remote:${CHAT_MODEL}`])
    expect(h.activeRemote()).toEqual(REMOTE)
  })

  it('does not run remote Gemini when the visible specialist selection is unavailable', async () => {
    const h = lifecycle()
    const run = createGrounderRunner({
      ...h.dependencies,
      installed: async () => false
    })
    let taskCalled = false

    await expect(
      run(async () => {
        taskCalled = true
      })
    ).rejects.toThrow(`The selected Computer Use model is not downloaded: ${SPECIALIST}`)

    expect(taskCalled).toBe(false)
    expect(h.activeRemote()).toEqual(REMOTE)
    expect(h.events).toEqual([])
  })
})
