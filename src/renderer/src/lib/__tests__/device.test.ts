import { describe, it, expect, afterEach, vi } from 'vitest'
import { deviceNoun, isMac, currentPlatform, primaryModifier } from '../device'

// The renderer wrapper resolves the platform from the preload-bridged
// `window.api.platform` and delegates the naming rule to shared/device.ts.
describe('renderer deviceNoun wrapper', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads window.api.platform: darwin -> Mac', () => {
    vi.stubGlobal('window', { api: { platform: 'darwin' } })
    expect(deviceNoun()).toBe('Mac')
  })

  it('reads window.api.platform: win32 -> device', () => {
    vi.stubGlobal('window', { api: { platform: 'win32' } })
    expect(deviceNoun()).toBe('device')
    expect(deviceNoun({ capitalize: true })).toBe('Device')
  })

  it('falls back to "device" when window.api is absent', () => {
    vi.stubGlobal('window', {})
    expect(deviceNoun()).toBe('device')
  })

  it('falls back to "device" when window itself is undefined (non-DOM env)', () => {
    vi.stubGlobal('window', undefined)
    expect(deviceNoun()).toBe('device')
  })

  it('isMac() reflects the bridged platform', () => {
    vi.stubGlobal('window', { api: { platform: 'darwin' } })
    expect(isMac()).toBe(true)
    vi.stubGlobal('window', { api: { platform: 'win32' } })
    expect(isMac()).toBe(false)
    vi.stubGlobal('window', {})
    expect(isMac()).toBe(false)
  })

  it('currentPlatform() returns the bridged value or "unknown"', () => {
    vi.stubGlobal('window', { api: { platform: 'linux' } })
    expect(currentPlatform()).toBe('linux')
    vi.stubGlobal('window', {})
    expect(currentPlatform()).toBe('unknown')
  })

  it('primaryModifier() reflects the bridged platform', () => {
    vi.stubGlobal('window', { api: { platform: 'darwin' } })
    expect(primaryModifier()).toBe('Cmd')
    vi.stubGlobal('window', { api: { platform: 'win32' } })
    expect(primaryModifier()).toBe('Ctrl')
    vi.stubGlobal('window', {})
    expect(primaryModifier()).toBe('Ctrl')
  })
})
