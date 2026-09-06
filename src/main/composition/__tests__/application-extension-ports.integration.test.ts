/**
 * Real Desktop optional-port registration through the composition boundary. Module resets model
 * separate application launches; no Off Grid module or platform boundary is replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => vi.resetModules())

describe('Desktop application extension-port composition', () => {
  it('returns the core-only ports and seals registration after root construction', async () => {
    const composition = await import('../application-extension-ports')

    expect(composition.consumeDesktopApplicationExtensionPorts()).toEqual({})
    expect(() => composition.registerDesktopApplicationExtensionPorts(() => ({}))).toThrow(
      'Desktop application extension ports registered after root construction'
    )
  })

  it('admits one product extension factory before root construction and consumes it once', async () => {
    const composition = await import('../application-extension-ports')
    const ports = {}
    const factory = vi.fn(() => ports)

    composition.registerDesktopApplicationExtensionPorts(factory)
    expect(() => composition.registerDesktopApplicationExtensionPorts(() => ({}))).toThrow(
      'Desktop application extension ports already registered'
    )
    expect(composition.consumeDesktopApplicationExtensionPorts()).toBe(ports)
    expect(factory).toHaveBeenCalledOnce()
  })
})
