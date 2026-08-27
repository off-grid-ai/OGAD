// The watchdog's poll strategy against a REAL tracker and fake Electron
// boundaries: parked cursor stays quiet, human drift pauses, our own overlay
// never counts, and stop() ends the watch. (The uiohook strategy is the native
// addon path - owned by the real-machine pass, like actuation itself.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  cursor: { x: 500, y: 500 },
  windows: [] as { x: number; y: number; width: number; height: number }[]
}))

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: () => ({ ...boundary.cursor }) },
  BrowserWindow: {
    getAllWindows: () =>
      boundary.windows.map((b) => ({
        isDestroyed: () => false,
        isVisible: () => true,
        getBounds: () => b
      }))
  }
}))

import { startUserInputWatch } from '../user-input-watch'
import { beginSynthetic, endSynthetic, resetSynthetic } from '../synthetic-tracker'

let stop: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  boundary.cursor = { x: 500, y: 500 }
  boundary.windows = []
})
afterEach(() => {
  stop?.()
  stop = null
  resetSynthetic()
  vi.useRealTimers()
})

/** Park the synthetic cursor at 500,500 and get past the grace window. */
function parkSyntheticCursor(): void {
  beginSynthetic({ x: 500, y: 500 })
  endSynthetic()
  vi.advanceTimersByTime(1_000) // > graceMs
}

describe('startUserInputWatch (poll fallback)', () => {
  it('stays quiet while the cursor rests where the rail parked it', () => {
    const onUserInput = vi.fn()
    stop = startUserInputWatch(onUserInput, 'poll')
    parkSyntheticCursor()
    vi.advanceTimersByTime(2_000)
    expect(onUserInput).not.toHaveBeenCalled()
  })

  it('pauses when a human moves the mouse away', () => {
    const onUserInput = vi.fn()
    stop = startUserInputWatch(onUserInput, 'poll')
    parkSyntheticCursor()
    boundary.cursor = { x: 900, y: 200 }
    vi.advanceTimersByTime(300)
    expect(onUserInput).toHaveBeenCalledWith('you moved the mouse')
  })

  it('interacting with our own window (the overlay) never pauses', () => {
    const onUserInput = vi.fn()
    boundary.windows = [{ x: 850, y: 150, width: 200, height: 100 }]
    stop = startUserInputWatch(onUserInput, 'poll')
    parkSyntheticCursor()
    boundary.cursor = { x: 900, y: 200 } // inside the overlay bounds
    vi.advanceTimersByTime(1_000)
    expect(onUserInput).not.toHaveBeenCalled()
  })

  it('stays quiet while a synthetic action is in flight, even mid-move', () => {
    const onUserInput = vi.fn()
    stop = startUserInputWatch(onUserInput, 'poll')
    beginSynthetic({ x: 500, y: 500 })
    boundary.cursor = { x: 700, y: 700 } // the rail itself is dragging
    vi.advanceTimersByTime(1_000)
    expect(onUserInput).not.toHaveBeenCalled()
    endSynthetic()
  })

  it('stop() ends the watch - no pauses after teardown', () => {
    const onUserInput = vi.fn()
    stop = startUserInputWatch(onUserInput, 'poll')
    parkSyntheticCursor()
    stop()
    stop = null
    boundary.cursor = { x: 0, y: 0 }
    vi.advanceTimersByTime(2_000)
    expect(onUserInput).not.toHaveBeenCalled()
  })

  it('a fresh watch resets stale synthetic state from the previous run', () => {
    beginSynthetic({ x: 1, y: 1 }) // stale, never ended - would suppress forever
    const onUserInput = vi.fn()
    stop = startUserInputWatch(onUserInput, 'poll')
    boundary.cursor = { x: 300, y: 300 }
    vi.advanceTimersByTime(300)
    expect(onUserInput).toHaveBeenCalled()
  })
})
