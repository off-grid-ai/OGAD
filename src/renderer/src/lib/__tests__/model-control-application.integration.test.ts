// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { desktopModelControl } from '../model-control-application'

describe('desktop model-control adapter failures', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        deleteModel: async () => ({ success: false, error: 'model removal denied' })
      }
    })
  })

  it('preserves the typed preload failure result', async () => {
    await expect(
      desktopModelControl.execute({ type: 'remove', modelId: 'local:model' })
    ).resolves.toEqual({ status: 'failed', error: 'model removal denied' })
  })
})
