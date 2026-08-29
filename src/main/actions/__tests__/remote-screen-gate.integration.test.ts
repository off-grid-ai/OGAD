import { describe, expect, it, vi } from 'vitest'
import type { ActionRecord } from '@offgrid/use'
import { withRemoteScreenGate } from '../remote-screen-gate'

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
})
