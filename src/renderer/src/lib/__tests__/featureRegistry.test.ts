import type { ComponentType } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FeatureModule = typeof import('../../bootstrap/featureRegistry')

const Icon = (() => null) as unknown as ComponentType<{ className?: string }>
const Screen = (() => null) as unknown as ComponentType
const ReplacementScreen = (() => null) as unknown as ComponentType

async function fresh(): Promise<FeatureModule> {
  vi.resetModules()
  return import('../../bootstrap/featureRegistry')
}

describe('featureRegistry', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('atomically registers a package-owned navigation and screen decision', async () => {
    const registry = await fresh()
    const unregister = registry.registerFeature({
      route: 'sync',
      label: 'Sync',
      icon: Icon,
      component: Screen
    })

    expect(registry.getRegisteredFeatures()).toEqual([
      expect.objectContaining({ route: 'sync', label: 'Sync', component: Screen })
    ])
    expect(registry.getCoreFeatures().map((feature) => feature.route)).toEqual(['sync'])
    expect(registry.getRegisteredFeature('sync')?.icon).toBe(Icon)
    const legacyNav = await import('../../bootstrap/navRegistry')
    expect(legacyNav.isProActive()).toBe(false)

    unregister()
    expect(registry.getRegisteredFeatures()).toEqual([])
  })

  it('does not expose a partial feature assembled through compatibility adapters', async () => {
    const registry = await fresh()
    registry.registerFeatureNavigation({ route: 'sync', label: 'Sync', icon: Icon })
    expect(registry.getRegisteredFeatures()).toEqual([])

    registry.registerFeatureScreen({ name: 'sync', component: Screen })
    expect(registry.getRegisteredFeature('sync')?.component).toBe(Screen)
    expect(registry.getRegisteredFeature('sync')?.kind).toBe('legacy-pro')
    expect(registry.getCoreFeatures()).toEqual([])
  })

  it('keeps first ownership and sorts complete features by navigation order', async () => {
    const registry = await fresh()
    registry.registerFeature({
      route: 'later',
      label: 'Later',
      icon: Icon,
      component: Screen,
      order: 200
    })
    registry.registerFeature({
      route: 'sync',
      label: 'Sync',
      icon: Icon,
      component: Screen,
      order: 10
    })
    registry.registerFeatureScreen({ name: 'sync', component: ReplacementScreen })

    expect(registry.getRegisteredFeatures().map((feature) => feature.route)).toEqual([
      'sync',
      'later'
    ])
    expect(registry.getRegisteredFeature('sync')?.component).toBe(Screen)
  })

  it('publishes stable immutable snapshots to subscribers', async () => {
    const registry = await fresh()
    let notifications = 0
    const unsubscribe = registry.subscribeToFeatures(() => notifications++)
    const initial = registry.getRegisteredFeatures()

    registry.registerFeature({ route: 'sync', label: 'Sync', icon: Icon, component: Screen })
    const registered = registry.getRegisteredFeatures()
    expect(registered).not.toBe(initial)
    expect(registry.getRegisteredFeatures()).toBe(registered)
    expect(Object.isFrozen(registered)).toBe(true)
    expect(notifications).toBe(1)

    unsubscribe()
    registry.registerFeature({ route: 'later', label: 'Later', icon: Icon, component: Screen })
    expect(notifications).toBe(1)
  })

  it('rejects invalid and duplicate atomic route ownership', async () => {
    const registry = await fresh()
    expect(() =>
      registry.registerFeature({ route: '../sync', label: 'Sync', icon: Icon, component: Screen })
    ).toThrow(/invalid feature route/i)

    registry.registerFeature({ route: 'sync', label: 'Sync', icon: Icon, component: Screen })
    expect(() =>
      registry.registerFeature({ route: 'sync', label: 'Other', icon: Icon, component: Screen })
    ).toThrow(/already registered/i)
  })
})
