import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopModelManagerPorts } from '../model-manager-ports'

describe('Desktop model manager port composition', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('requires registration before exposing the real manager boundary', async () => {
    const { desktopModelManagerPorts } = await import('../model-manager-ports')

    expect(() => desktopModelManagerPorts.listInstalled()).toThrow(
      'Desktop model manager ports are not initialized.'
    )
  })

  it('keeps one stable proxy bound to the registered Desktop manager', async () => {
    const { desktopModelManagerPorts, registerDesktopModelManagerPorts } =
      await import('../model-manager-ports')
    const calls: string[] = []
    const manager: DesktopModelManagerPorts & { prefix: string } = {
      prefix: 'desktop',
      async getCatalog() {
        calls.push(`${this.prefix}:catalog`)
        return { kinds: ['text'], models: [{ id: 'local-chat' }] }
      },
      async listInstalled() {
        calls.push(`${this.prefix}:installed`)
        return ['local-chat']
      },
      async resolveCanonicalModelSelectionId(modelId) {
        calls.push(`${this.prefix}:resolve:${modelId}`)
        return `canonical:${modelId}`
      },
      async projectActiveTextModelSelection(modelId) {
        calls.push(`${this.prefix}:select:${modelId}`)
        return { success: true }
      }
    }

    registerDesktopModelManagerPorts(manager)

    await expect(desktopModelManagerPorts.getCatalog()).resolves.toEqual({
      kinds: ['text'],
      models: [{ id: 'local-chat' }]
    })
    await expect(desktopModelManagerPorts.listInstalled()).resolves.toEqual(['local-chat'])
    await expect(desktopModelManagerPorts.resolveCanonicalModelSelectionId('alias')).resolves.toBe(
      'canonical:alias'
    )
    await expect(
      desktopModelManagerPorts.projectActiveTextModelSelection('local-chat')
    ).resolves.toEqual({ success: true })
    expect(calls).toEqual([
      'desktop:catalog',
      'desktop:installed',
      'desktop:resolve:alias',
      'desktop:select:local-chat'
    ])
  })
})
