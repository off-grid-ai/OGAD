// Tests for the renderer screen-registry seam (bootstrap/screenRegistry.ts).
// Module-level singleton -> each test re-imports fresh for isolation.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ComponentType } from 'react'

type ScreenModule = typeof import('../../bootstrap/screenRegistry')

const A = (() => null) as unknown as ComponentType<Record<string, unknown>>
const B = (() => null) as unknown as ComponentType<Record<string, unknown>>
const Icon = (() => null) as unknown as ComponentType<Record<string, unknown>>

async function fresh(): Promise<ScreenModule> {
  vi.resetModules()
  return import('../../bootstrap/screenRegistry')
}

async function registerCompleteFeature(
  screens: ScreenModule,
  screen: Parameters<ScreenModule['registerScreen']>[0]
): Promise<void> {
  screens.registerScreen(screen)
  const nav = await import('../../bootstrap/navRegistry')
  nav.registerNav({ route: screen.name, label: screen.name, icon: Icon })
}

describe('screenRegistry', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('starts empty', async () => {
    const m = await fresh()
    expect(m.getRegisteredScreens()).toEqual([])
    expect(m.getRegisteredScreen('day')).toBeUndefined()
  })

  it('publishes a screen after its matching navigation registers', async () => {
    const m = await fresh()
    m.registerScreen({ name: 'day', component: A })
    expect(m.getRegisteredScreen('day')).toBeUndefined()
    const nav = await import('../../bootstrap/navRegistry')
    nav.registerNav({ route: 'day', label: 'Day', icon: Icon })
    expect(m.getRegisteredScreen('day')?.component).toBe(A)
    expect(m.getRegisteredScreens()).toHaveLength(1)
  })

  it('returns undefined for an unregistered name', async () => {
    const m = await fresh()
    await registerCompleteFeature(m, { name: 'day', component: A })
    expect(m.getRegisteredScreen('replay')).toBeUndefined()
  })

  it('dedupes by name - first registration wins', async () => {
    const m = await fresh()
    await registerCompleteFeature(m, { name: 'day', component: A })
    await registerCompleteFeature(m, { name: 'day', component: B })
    expect(m.getRegisteredScreens()).toHaveLength(1)
    expect(m.getRegisteredScreen('day')?.component).toBe(A)
  })

  it('keeps distinct screens in registration order', async () => {
    const m = await fresh()
    await registerCompleteFeature(m, { name: 'day', component: A })
    await registerCompleteFeature(m, { name: 'replay', component: B })
    expect(m.getRegisteredScreens().map((s) => s.name)).toEqual(['day', 'replay'])
  })
})
