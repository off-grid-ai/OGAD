import { vi } from 'vitest'

import { DEMO_PROJECTS, createDemoApi } from '../../preview/demo-api'

export const APP_PROJECTS = DEMO_PROJECTS

/** The preload bridge for a mounted App: the same demo bridge the translation preview uses. */
export function installAppBoundary(overrides: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = createDemoApi(overrides)
}

export function installAppStorage(): Storage {
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value))
  }
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
  vi.stubGlobal('localStorage', storage)
  return storage
}

export function installAppBrowserBoundary(): void {
  vi.stubGlobal('__OFFGRID_PRO__', false)
  ;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
}
