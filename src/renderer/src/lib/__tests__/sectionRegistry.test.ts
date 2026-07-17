// Tests for the Settings-section registry seam (bootstrap/sectionRegistry.ts).
// Module-level singleton -> each test re-imports fresh for isolation.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ComponentType } from 'react'

type SectionModule = typeof import('../../bootstrap/sectionRegistry')

const C = (() => null) as unknown as ComponentType<Record<string, unknown>>

async function fresh(): Promise<SectionModule> {
  vi.resetModules()
  return import('../../bootstrap/sectionRegistry')
}

describe('sectionRegistry', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('starts empty', async () => {
    const m = await fresh()
    expect(m.getRegisteredSettingsSections()).toEqual([])
  })

  it('registers a section', async () => {
    const m = await fresh()
    const unregister = m.registerSettingsSection({ id: 'proactive', component: C })
    expect(m.getRegisteredSettingsSections().map((s) => s.id)).toEqual(['proactive'])
    unregister()
    expect(m.getRegisteredSettingsSections()).toEqual([])
  })

  it('owns core and legacy Pro classification instead of inferring it from ids', async () => {
    const m = await fresh()
    m.registerSettingsSection({ id: 'pro-section', component: C })
    m.registerCoreSettingsSection({ id: 'sync', component: C })

    expect(m.getProSettingsSections().map((section) => section.id)).toEqual(['pro-section'])
    expect(m.getCoreSettingsSections().map((section) => section.id)).toEqual(['sync'])
  })

  it('rejects invalid and duplicate core section ownership', async () => {
    const m = await fresh()
    expect(() => m.registerCoreSettingsSection({ id: '../sync', component: C })).toThrow(
      /invalid settings section id/i
    )
    m.registerCoreSettingsSection({ id: 'sync', component: C })
    expect(() => m.registerCoreSettingsSection({ id: 'sync', component: C })).toThrow(
      /already registered/i
    )
  })

  it('dedupes by id - a duplicate id is ignored', async () => {
    const m = await fresh()
    m.registerSettingsSection({ id: 'proactive', component: C })
    m.registerSettingsSection({ id: 'proactive', component: C })
    expect(m.getRegisteredSettingsSections()).toHaveLength(1)
  })

  it('sorts by order ascending', async () => {
    const m = await fresh()
    m.registerSettingsSection({ id: 'b', component: C, order: 20 })
    m.registerSettingsSection({ id: 'a', component: C, order: 10 })
    expect(m.getRegisteredSettingsSections().map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('defaults a missing order to 100', async () => {
    const m = await fresh()
    m.registerSettingsSection({ id: 'noOrder', component: C })
    m.registerSettingsSection({ id: 'low', component: C, order: 50 })
    m.registerSettingsSection({ id: 'high', component: C, order: 150 })
    expect(m.getRegisteredSettingsSections().map((s) => s.id)).toEqual(['low', 'noOrder', 'high'])
  })

  it('publishes a stable snapshot and notifies active subscribers', async () => {
    const m = await fresh()
    let notifications = 0
    const unsubscribe = m.subscribeToSettingsSections(() => notifications++)
    const initial = m.getRegisteredSettingsSections()
    m.registerSettingsSection({ id: 'a', component: C })
    const registered = m.getRegisteredSettingsSections()
    expect(registered).not.toBe(initial)
    expect(m.getRegisteredSettingsSections()).toBe(registered)
    expect(notifications).toBe(1)
    unsubscribe()
    m.registerSettingsSection({ id: 'b', component: C })
    expect(notifications).toBe(1)
    expect(m.getRegisteredSettingsSections()).toHaveLength(2)
  })
})
