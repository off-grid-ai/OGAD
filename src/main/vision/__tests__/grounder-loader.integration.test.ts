import { describe, expect, it } from 'vitest'
import { createGrounderRunner, type GrounderRunnerDependencies } from '../grounder-loader'

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
      modelStrategy: () => 'separate_specialist',
      selectedModelId: () => SPECIALIST,
      installed: async () => true,
      activeModel: () => activeModel,
      activeModelId: () => activeModel.id,
      activeRemote: () => activeRemote,
      isGrounder: (model) => model.id === SPECIALIST,
      load: async (modelId) => {
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
  it('loads the specialist for one hybrid grounded action and restores the text reasoner', async () => {
    const h = lifecycle()
    const run = createGrounderRunner({
      ...h.dependencies,
      modelStrategy: () => 'text_plus_specialist'
    })

    await run(async () => {
      h.events.push('ground-action')
      expect(h.activeModelId()).toBe(SPECIALIST)
    })

    expect(h.activeModelId()).toBe(CHAT_MODEL)
    expect(h.activeRemote()).toEqual(REMOTE)
    expect(h.events).toEqual([
      'suspend-remote',
      `load:${SPECIALIST}`,
      'ground-action',
      `restore-local:${CHAT_MODEL}`,
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
    expect(h.activeModelId()).toBe(CHAT_MODEL)
    expect(h.activeRemote()).toEqual(REMOTE)
    expect(h.events).toEqual([
      'suspend-remote',
      `load:${SPECIALIST}`,
      'run',
      `restore-local:${CHAT_MODEL}`,
      `restore-remote:${CHAT_MODEL}`
    ])
  })

  it('restores local and remote models when the specialist task fails', async () => {
    const h = lifecycle()
    const run = createGrounderRunner(h.dependencies)

    await expect(
      run(async () => {
        h.events.push('run')
        throw new Error('browser task failed')
      })
    ).rejects.toThrow('browser task failed')

    expect(h.activeModelId()).toBe(CHAT_MODEL)
    expect(h.activeRemote()).toEqual(REMOTE)
    expect(h.events.slice(-2)).toEqual([
      `restore-local:${CHAT_MODEL}`,
      `restore-remote:${CHAT_MODEL}`
    ])
  })

  it('restores local and remote models when the specialist task is aborted', async () => {
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

    expect(h.activeModelId()).toBe(CHAT_MODEL)
    expect(h.activeRemote()).toEqual(REMOTE)
    expect(h.events.slice(-2)).toEqual([
      `restore-local:${CHAT_MODEL}`,
      `restore-remote:${CHAT_MODEL}`
    ])
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
