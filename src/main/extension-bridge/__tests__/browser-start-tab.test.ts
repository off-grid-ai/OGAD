import { describe, expect, it } from 'vitest'
import { createStartTabs, START_TAB_TTL_MS } from '../browser-start-tab'

describe('start tabs', () => {
  it("gives the task the browser's offered tab, once", () => {
    const tabs = createStartTabs(() => 0)
    tabs.offer('b1', 42)
    expect(tabs.has('b1')).toBe(true)
    expect(tabs.has('b2')).toBe(false)
    expect(tabs.take('b1')).toBe(42)
    expect(tabs.take('b1')).toBeNull()
    expect(tabs.has('b1')).toBe(false)
  })

  it('lets an offer nobody took lapse, so it never steers a later task', () => {
    let t = 0
    const tabs = createStartTabs(() => t)
    tabs.offer('b1', 7)
    t = START_TAB_TTL_MS + 1
    expect(tabs.has('b1')).toBe(false)
    expect(tabs.take('b1')).toBeNull()
  })

  it('keeps the newest offer per browser', () => {
    const tabs = createStartTabs(() => 0)
    tabs.offer('b1', 1)
    tabs.offer('b1', 2)
    expect(tabs.take('b1')).toBe(2)
  })
})
