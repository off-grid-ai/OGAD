// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { submitTaskGuidance } from '../task-guidance-client'

type Api = typeof window.api

/** Fake at the preload boundary only: `window.api.tasks.guideTask` + `addRagMessage`. */
function installApi(overrides: { guideTask?: unknown; addRagMessage?: unknown }): {
  addRagMessage: ReturnType<typeof vi.fn>
} {
  const addRagMessage = vi.fn(async () => ({ id: 1, uuid: 'u1' }))
  const api = {
    tasks: overrides.guideTask === undefined ? {} : { guideTask: overrides.guideTask },
    addRagMessage: overrides.addRagMessage ?? addRagMessage
  }
  Object.defineProperty(window, 'api', { value: api as unknown as Api, configurable: true })
  return { addRagMessage }
}

const accepted = (): ReturnType<typeof vi.fn> =>
  vi.fn(async () => ({ available: true, accepted: true }))

describe('submitTaskGuidance', () => {
  let chatEvents: CustomEvent[]
  const onChatEvent = (event: Event): void => {
    chatEvents.push(event as CustomEvent)
  }
  beforeEach(() => {
    chatEvents = []
    window.addEventListener('og:task-guidance-message', onChatEvent)
  })
  afterEach(() => {
    window.removeEventListener('og:task-guidance-message', onChatEvent)
    Reflect.deleteProperty(window, 'api')
  })

  it('reports unavailable with a restart hint when the preload has no guideTask bridge', async () => {
    const { addRagMessage } = installApi({})
    await expect(submitTaskGuidance({ taskId: 't1', text: 'go' })).resolves.toEqual({
      available: false,
      accepted: false,
      reason: 'Restart Off Grid AI to enable live guidance for new tasks.'
    })
    expect(addRagMessage).not.toHaveBeenCalled()
    expect(chatEvents).toHaveLength(0)
  })

  it('forwards text and attachments to the task owner', async () => {
    const guideTask = accepted()
    installApi({ guideTask })
    const attachments = [{ name: 'spec.md', bytes: new Uint8Array([1]) }]
    await submitTaskGuidance({ taskId: 't1', text: 'go', attachments })
    expect(guideTask).toHaveBeenCalledWith('t1', { text: 'go', attachments })
  })

  it('defaults attachments to an empty list when none are given', async () => {
    const guideTask = accepted()
    installApi({ guideTask })
    await submitTaskGuidance({ taskId: 't1', text: 'go' })
    expect(guideTask).toHaveBeenCalledWith('t1', { text: 'go', attachments: [] })
  })

  it.each([
    ['the owner rejected the guidance', { available: true, accepted: false, reason: 'done' }, 'j1'],
    ['there is no journey to project into', { available: true, accepted: true }, undefined],
    ['the journey IS the task (no separate chat)', { available: true, accepted: true }, 't1']
  ])(
    'returns the owner result without a chat projection when %s',
    async (_case, result, journeyId) => {
      const guideTask = vi.fn(async () => result)
      const { addRagMessage } = installApi({ guideTask })

      await expect(submitTaskGuidance({ taskId: 't1', journeyId, text: 'go' })).resolves.toBe(
        result
      )
      expect(addRagMessage).not.toHaveBeenCalled()
      expect(chatEvents).toHaveLength(0)
    }
  )

  it('projects accepted text guidance into the owning chat and notifies it', async () => {
    const guideTask = accepted()
    const { addRagMessage } = installApi({ guideTask })
    const attachments = [{ name: 'a.png', bytes: new Uint8Array([1]) }]

    const result = await submitTaskGuidance({
      taskId: 't1',
      journeyId: 'j1',
      text: 'go',
      attachments
    })

    expect(result).toEqual({ available: true, accepted: true })
    expect(addRagMessage).toHaveBeenCalledWith('j1', 'user', 'go', {
      taskGuidance: { taskId: 't1', state: 'accepted', attachmentNames: ['a.png'] }
    })
    expect(chatEvents).toHaveLength(1)
    expect(chatEvents[0]?.detail).toEqual({ conversationId: 'j1' })
  })

  it('describes attachment-only guidance by the attachment names', async () => {
    const { addRagMessage } = installApi({ guideTask: accepted() })
    await submitTaskGuidance({
      taskId: 't1',
      journeyId: 'j1',
      text: '',
      attachments: [
        { name: 'a.png', bytes: new Uint8Array([1]) },
        { name: 'b.txt', bytes: new Uint8Array([2]) }
      ]
    })
    expect(addRagMessage).toHaveBeenCalledWith(
      'j1',
      'user',
      'Attached task guidance: a.png, b.txt',
      { taskGuidance: { taskId: 't1', state: 'accepted', attachmentNames: ['a.png', 'b.txt'] } }
    )
  })

  it('falls back to a generic description when there is neither text nor attachments', async () => {
    const { addRagMessage } = installApi({ guideTask: accepted() })
    await submitTaskGuidance({ taskId: 't1', journeyId: 'j1', text: '' })
    expect(addRagMessage).toHaveBeenCalledWith(
      'j1',
      'user',
      'Attached task guidance: guidance attachment',
      { taskGuidance: { taskId: 't1', state: 'accepted', attachmentNames: [] } }
    )
  })
})
