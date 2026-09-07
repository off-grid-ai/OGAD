import { describe, expect, it, vi } from 'vitest'
import type { ActionRecord } from '@offgrid/use'
import { withRemoteScreenGate } from '../remote-screen-gate'
import {
  currentRemoteScreenTaskSession,
  runWithRemoteScreenTaskSession
} from '../remote-screen-session'

const action = { id: 'screen-task-1' } as ActionRecord
const remoteServer = {
  id: 'server-1',
  name: 'Remote vision',
  provider: 'custom' as const,
  endpoint: 'https://vision.example/v1',
  model: 'vision-model',
  screenFramesAllowed: false,
  apiKey: 'secret'
}

describe('remote screen execution gate', () => {
  it.each(['web_use', 'computer_use'] as const)(
    'does not enter the %s host before the user allows remote screen images',
    async (taskKind) => {
      const execute = vi.fn(async () => ({ ok: true as const, effectId: 'done' }))
      const guarded = withRemoteScreenGate(taskKind, execute, {
        modelStrategy: () => 'same_as_chat',
        activeServer: () => remoteServer
      })

      await expect(guarded(action)).resolves.toMatchObject({
        ok: false,
        detail: expect.stringContaining('vision.example')
      })
      expect(execute).not.toHaveBeenCalled()
    }
  )

  it('enters the host once after the saved server allowance is present', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, effectId: 'done' }))
    const guarded = withRemoteScreenGate('computer_use', execute, {
      modelStrategy: () => 'same_as_chat',
      activeServer: () => ({ ...remoteServer, screenFramesAllowed: true })
    })

    await expect(guarded(action)).resolves.toEqual({ ok: true, effectId: 'done' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('keeps the allowed server and strategy fixed for the complete host execution', async () => {
    let strategy: 'same_as_chat' | 'separate_specialist' = 'same_as_chat'
    let server = { ...remoteServer, screenFramesAllowed: true }
    const observed: unknown[] = []
    const execute = vi.fn(async () => {
      observed.push(currentRemoteScreenTaskSession())
      strategy = 'separate_specialist'
      server = {
        ...remoteServer,
        id: 'server-2',
        name: 'Changed server',
        screenFramesAllowed: false
      }
      await Promise.resolve()
      observed.push(currentRemoteScreenTaskSession())
      return { ok: true as const, effectId: 'done' }
    })
    const guarded = withRemoteScreenGate('computer_use', execute, {
      modelStrategy: () => strategy,
      activeServer: () => server
    })

    await expect(guarded(action)).resolves.toEqual({ ok: true, effectId: 'done' })
    expect(observed).toEqual([
      expect.objectContaining({
        taskKind: 'computer_use',
        modelStrategy: 'same_as_chat',
        activeServer: expect.objectContaining({ id: 'server-1', screenFramesAllowed: true })
      }),
      expect.objectContaining({
        taskKind: 'computer_use',
        modelStrategy: 'same_as_chat',
        activeServer: expect.objectContaining({ id: 'server-1', screenFramesAllowed: true })
      })
    ])
    expect(currentRemoteScreenTaskSession()).toBeUndefined()
  })

  it('supports one local specialist request without changing the outer remote reasoner', async () => {
    const observed: unknown[] = []
    const execute = vi.fn(async () => {
      const outer = currentRemoteScreenTaskSession()
      observed.push(outer?.activeServer?.id)
      await runWithRemoteScreenTaskSession({ ...outer!, activeServer: null }, async () => {
        observed.push(currentRemoteScreenTaskSession()?.activeServer)
      })
      observed.push(currentRemoteScreenTaskSession()?.activeServer?.id)
      return { ok: true as const, effectId: 'done' }
    })
    const guarded = withRemoteScreenGate('computer_use', execute, {
      modelStrategy: () => 'text_plus_specialist',
      activeServer: () => ({ ...remoteServer, screenFramesAllowed: true })
    })

    await expect(guarded(action)).resolves.toEqual({ ok: true, effectId: 'done' })
    expect(observed).toEqual(['server-1', null, 'server-1'])
  })
})
