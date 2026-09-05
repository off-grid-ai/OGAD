// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { failed } from '@offgrid/application'
import { modelControlClient } from '../model-control-client'

describe('desktop model-control adapter failures', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        controlModel: async () => failed({ kind: 'runtime', message: 'model removal denied' })
      }
    })
  })

  it('preserves the typed preload failure result', async () => {
    await expect(
      modelControlClient.control({ type: 'remove', modelId: 'local:model' })
    ).resolves.toEqual({
      ok: false,
      failure: { kind: 'runtime', message: 'model removal denied' }
    })
  })

  it('forwards the Shared projection stream and returns the preload unsubscribe', () => {
    const projection = { kinds: ['text'], downloads: [] }
    const release = vi.fn()
    const listener = vi.fn()
    const observe = vi.fn((publish: (value: unknown) => void) => {
      publish(projection)
      return release
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { onModelControlProjection: observe }
    })

    const unsubscribe = modelControlClient.observe(listener as never)

    expect(listener).toHaveBeenCalledWith(projection)
    unsubscribe()
    expect(release).toHaveBeenCalledOnce()
  })
})
