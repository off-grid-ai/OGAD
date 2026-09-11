// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom provides localStorage + document but NOT matchMedia. The theme module runs a
// load-time side effect (addEventListener on the media query, and window.ogTheme), so
// matchMedia must exist before the dynamic import below. We control the dark/light branch
// by flipping this flag and re-reading it in the fake matchMedia.
let prefersDark = true
const listeners: Array<() => void> = []

// jsdom does not expose a usable bare `localStorage` global (Node's experimental one
// shadows it and throws), so stub an in-memory Store the module's bare `localStorage`
// calls resolve against. `document` from jsdom is used as-is for the <html> dataset.
function makeLocalStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear()
  }
}
let store = makeLocalStorage()

function installMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('dark') ? prefersDark : !prefersDark,
      media: query,
      addEventListener: (_: string, cb: () => void) => listeners.push(cb),
      removeEventListener: () => {}
    }))
  )
}

// Import fresh per test so the KEY-backed getThemeMode reads the current localStorage and
// the module-load listener registration is deterministic.
async function loadTheme(): Promise<typeof import('../theme')> {
  vi.resetModules()
  installMatchMedia()
  vi.stubGlobal('localStorage', store)
  return import('../theme')
}

beforeEach(() => {
  store = makeLocalStorage()
  vi.stubGlobal('localStorage', store)
  listeners.length = 0
  prefersDark = true
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getThemeMode', () => {
  it('returns a valid stored value', async () => {
    localStorage.setItem('og-theme', 'light')
    const { getThemeMode } = await loadTheme()
    expect(getThemeMode()).toBe('light')
  })

  it('defaults to system when nothing is stored', async () => {
    const { getThemeMode } = await loadTheme()
    expect(getThemeMode()).toBe('system')
  })

  it('defaults to system when the stored value is invalid', async () => {
    localStorage.setItem('og-theme', 'neon')
    const { getThemeMode } = await loadTheme()
    expect(getThemeMode()).toBe('system')
  })
})

describe('resolveTheme', () => {
  it('passes an explicit light/dark mode straight through', async () => {
    const { resolveTheme } = await loadTheme()
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('resolves system to dark when the OS prefers dark', async () => {
    prefersDark = true
    const { resolveTheme } = await loadTheme()
    expect(resolveTheme('system')).toBe('dark')
  })

  it('resolves system to light when the OS prefers light', async () => {
    prefersDark = false
    const { resolveTheme } = await loadTheme()
    expect(resolveTheme('system')).toBe('light')
  })
})

describe('setThemeMode', () => {
  it('persists the mode to localStorage and applies it to <html>', async () => {
    const { setThemeMode } = await loadTheme()
    setThemeMode('light')
    expect(localStorage.getItem('og-theme')).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('notifies mounted controls when another surface changes the mode', async () => {
    const { onThemeModeChanged, setThemeMode } = await loadTheme()
    const modes: string[] = []
    const unsubscribe = onThemeModeChanged((mode) => modes.push(mode))

    setThemeMode('light')
    setThemeMode('dark')
    unsubscribe()
    setThemeMode('system')

    expect(modes).toEqual(['light', 'dark'])
  })
})

describe('cycleThemeMode', () => {
  it('walks dark -> light -> system -> dark through every arm', async () => {
    localStorage.setItem('og-theme', 'dark')
    const { cycleThemeMode, getThemeMode } = await loadTheme()

    expect(cycleThemeMode()).toBe('light')
    expect(getThemeMode()).toBe('light')

    expect(cycleThemeMode()).toBe('system')
    expect(getThemeMode()).toBe('system')

    expect(cycleThemeMode()).toBe('dark')
    expect(getThemeMode()).toBe('dark')
  })
})

describe('module load side effect', () => {
  it('exposes window.ogTheme and re-applies on OS scheme change while following system', async () => {
    localStorage.setItem('og-theme', 'system')
    delete document.documentElement.dataset.theme
    prefersDark = false
    await loadTheme()

    expect(typeof window.ogTheme.cycle).toBe('function')

    // OS flips to dark; the registered listener re-applies because we follow system.
    prefersDark = true
    listeners.forEach((cb) => cb())
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('does NOT re-apply on OS change when the user pinned an explicit mode', async () => {
    localStorage.setItem('og-theme', 'light')
    delete document.documentElement.dataset.theme
    prefersDark = false
    await loadTheme()

    prefersDark = true
    listeners.forEach((cb) => cb())
    // Listener guards on getThemeMode()==='system'; explicit 'light' means no re-apply.
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })
})
