// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
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
})
