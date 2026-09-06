import { encodeModelRouteId } from '@offgrid/models'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  systemPreferences: { isTrustedAccessibilityClient: () => true }
}))

vi.mock('../../models-manager', () => ({
  resolveModelIdentity: vi.fn()
}))

describe('AX computer-use model display identity', () => {
  it('keeps a display-name failure noncritical and falls back at the caller boundary', async () => {
    const { resolveComputerUseModelIdentity } = await import('../ax-host')
    const routeId = encodeModelRouteId({
      adapterId: 'desktop.remote-chat',
      serverId: 'server-b',
      modelId: 'qwen'
    })
    const diagnostic = new Error('catalog unavailable')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      resolveComputerUseModelIdentity({ id: routeId }, async () => {
        throw diagnostic
      })
    ).resolves.toEqual({ modelId: routeId, modelName: 'qwen' })
    expect(error).toHaveBeenCalledWith(
      '[ax-rail] Model display identity unavailable; using selected model id.',
      diagnostic
    )
  })
})
