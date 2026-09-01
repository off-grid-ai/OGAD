import { describe, expect, it } from 'vitest'
import {
  LLMService,
  ModelResidencyManager,
  runtimeModelRouteId,
  type ModelModality,
  type RuntimeModel
} from '@offgrid/models'
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
    const models = new LLMService({
      read: (modality) => selections.get(modality) ?? null,
      write: (modality, routeId) => {
        selections.set(modality, routeId)
      }
    })
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
        ready: true,
        loaded: true,
        residentSizeMB: 200,
        peakSizeMB: 240
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
        peakSizeMB: 360
      }
    ]
    models.registerAdapter({ id: 'desktop-test-inventory', listModels: async () => runtimeModels })
    await models.refresh()
    const chatRoute = runtimeModelRouteId(runtimeModels[0]!)
    await models.select('text', chatRoute)
    const events: string[] = []
    const residency = new ModelResidencyManager({
      current: () => ({ totalMB: 16_384, availableMB: 16_384, platform: 'desktop' })
    })
    const chatLease = await residency.acquire(
      { key: `text:${chatRoute}`, modelId: chatRoute, type: 'text', sizeMB: 240 },
      {
        load: async () => {
          events.push('load-chat')
        },
        unload: async () => {
          events.push('unload-chat')
        }
      }
    )
    await chatLease.release()
    const services = {
      llm: models,
      residency,
      refresh: () => models.refresh(),
      routeIdFor: (modality: ModelModality, nativeModelId?: string) =>
        models.list(modality).find((model) => !nativeModelId || model.id === nativeModelId)
          ?.routeId,
      select: async (modality: ModelModality, routeId: string | null) => {
        try {
          await models.select(modality, routeId)
          return { success: true }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
      unload: async (modality: ModelModality) => {
        let unloaded = false
        for (const resident of residency.getResidents().filter((item) => item.type === modality)) {
          unloaded = (await residency.evictByKey(resident.key)) || unloaded
        }
        return unloaded
      },
      warmText: async () => {
        const model = models.active('text').model
        if (!model) return false
        const routeId = model.routeId ?? runtimeModelRouteId(model)
        const lease = await residency.acquire(
          { key: `text:${routeId}`, modelId: routeId, type: 'text', sizeMB: 240 },
          {
            load: async () => {
              events.push('load-chat')
            },
            unload: async () => {
              events.push('unload-chat')
            }
          }
        )
        await lease.release()
        return lease.loaded
      }
    }
    const lifecycle = createGrounderLifecycle(services, {
      project: async (modelId) => {
        events.push(`project:${modelId}`)
        return { success: true }
      },
      restart: async () => {
        events.push('restart-grounder')
      },
      unload: async () => {
        events.push('unload-grounder')
      }
    })

    await lifecycle.load(SPECIALIST)

    expect(models.active('computer_use').model?.id).toBe(SPECIALIST)
    expect(residency.getResidents().map((resident) => resident.type)).toEqual(['computer_use'])
    expect(events).toEqual([
      'load-chat',
      'unload-chat',
      `project:${SPECIALIST}`,
      'restart-grounder'
    ])

    await lifecycle.restoreLocal(CHAT_MODEL)

    expect(models.active('text').model?.id).toBe(CHAT_MODEL)
    expect(residency.getResidents().map((resident) => resident.type)).toEqual(['text'])
    expect(events.slice(-2)).toEqual(['unload-grounder', 'load-chat'])
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
