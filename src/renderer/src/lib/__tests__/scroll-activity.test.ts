// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initScrollActivity, SCROLL_BAR_LINGER_MS } from '../scroll-activity'

let stop: () => void

beforeEach(() => {
  vi.useFakeTimers()
  stop = initScrollActivity()
})
afterEach(() => {
  stop()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('scroll bars while scrolling', () => {
  it('marks only the area that scrolls, and clears it a moment after it stops', () => {
    const list = document.createElement('div')
    const other = document.createElement('div')
    document.body.append(list, other)
    list.dispatchEvent(new Event('scroll'))
    expect(list.hasAttribute('data-scrolling')).toBe(true)
    expect(other.hasAttribute('data-scrolling')).toBe(false)

    // Still scrolling: the bar stays between wheel ticks.
    vi.advanceTimersByTime(SCROLL_BAR_LINGER_MS - 100)
    list.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(SCROLL_BAR_LINGER_MS - 100)
    expect(list.hasAttribute('data-scrolling')).toBe(true)

    vi.advanceTimersByTime(100)
    expect(list.hasAttribute('data-scrolling')).toBe(false)
  })

  it('marks the page itself when the document scrolls', () => {
    document.dispatchEvent(new Event('scroll'))
    expect(document.documentElement.hasAttribute('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(SCROLL_BAR_LINGER_MS)
    expect(document.documentElement.hasAttribute('data-scrolling')).toBe(false)
  })
})
