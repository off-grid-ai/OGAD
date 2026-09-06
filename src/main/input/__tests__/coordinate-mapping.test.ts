import { describe, expect, it } from 'vitest'
import {
  actuationScale,
  imagePointToScreen,
  mapActionToScreen,
  type DisplayGeometry
} from '../coordinate-mapping'
import { planAspectPreservingResize, withCaptureOffset } from '../../vision/screenshot-geometry'

// A primary display at the origin. width/height are unused by the mapping but kept
// realistic (a 2560x1440 panel reported at 150% is 1707x960 DIP).
const primary = (scaleFactor: number): DisplayGeometry => ({
  bounds: { x: 0, y: 0, width: 1707, height: 960 },
  scaleFactor
})

describe('actuationScale', () => {
  it('is the raw scaleFactor on Windows (DIP -> physical pixels)', () => {
    expect(actuationScale('win32', 1.5)).toBe(1.5)
    expect(actuationScale('win32', 1.25)).toBe(1.25)
    expect(actuationScale('win32', 1)).toBe(1)
  })

  it('is always 1 off Windows - macOS/Linux position in points, not physical pixels', () => {
    expect(actuationScale('darwin', 2)).toBe(1)
    expect(actuationScale('linux', 1.5)).toBe(1)
  })
})

describe('imagePointToScreen', () => {
  it('macOS: the DIP point is used as-is (Retina 2x is transparent to Quartz)', () => {
    // scaleFactor 2 (Retina) must NOT scale the coordinate on mac.
    expect(
      imagePointToScreen({ x: 400, y: 300 }, { display: primary(2), platform: 'darwin' })
    ).toEqual({ x: 400, y: 300 })
  })

  it('Windows at 100%: unchanged', () => {
    expect(
      imagePointToScreen({ x: 400, y: 300 }, { display: primary(1), platform: 'win32' })
    ).toEqual({ x: 400, y: 300 })
  })

  it('Windows at 150%: DIP is scaled to physical pixels', () => {
    // The core Windows fix: a click at DIP (400,300) on a 150% display is physical (600,450).
    expect(
      imagePointToScreen({ x: 400, y: 300 }, { display: primary(1.5), platform: 'win32' })
    ).toEqual({
      x: 600,
      y: 450
    })
  })

  it('Windows at 125%: rounds to the nearest physical pixel', () => {
    // 401 * 1.25 = 501.25 -> 501; 301 * 1.25 = 376.25 -> 376.
    expect(
      imagePointToScreen({ x: 401, y: 301 }, { display: primary(1.25), platform: 'win32' })
    ).toEqual({
      x: 501,
      y: 376
    })
  })

  it('offsets by the display origin for a second monitor (same scale)', () => {
    const secondary: DisplayGeometry = {
      bounds: { x: 1707, y: 0, width: 1707, height: 960 },
      scaleFactor: 1.5
    }
    // (1707 + 100) * 1.5 = 2710.5 -> 2711 ; (0 + 200) * 1.5 = 300.
    expect(
      imagePointToScreen({ x: 100, y: 200 }, { display: secondary, platform: 'win32' })
    ).toEqual({ x: 2711, y: 300 })
  })

  it('macOS second monitor: origin offset applies, no scaling', () => {
    const secondary: DisplayGeometry = {
      bounds: { x: 1440, y: 0, width: 1440, height: 900 },
      scaleFactor: 2
    }
    expect(
      imagePointToScreen({ x: 100, y: 200 }, { display: secondary, platform: 'darwin' })
    ).toEqual({ x: 1540, y: 200 })
  })

  it('maps a resized Retina screenshot to macOS points, not device pixels', () => {
    const geometry = planAspectPreservingResize({ width: 1440, height: 900 }, 720)
    expect(
      imagePointToScreen(
        { x: 360, y: 225 },
        { display: primary(2), platform: 'darwin', screenshot: geometry }
      )
    ).toEqual({
      x: 720,
      y: 450
    })
  })

  it('uses an explicit physical origin for a mixed-DPI Windows display', () => {
    const secondary: DisplayGeometry = {
      bounds: { x: 1920, y: -200, width: 1707, height: 960 },
      scaleFactor: 1.5,
      physicalOrigin: { x: 1920, y: -300 }
    }
    expect(
      imagePointToScreen({ x: 100, y: 200 }, { display: secondary, platform: 'win32' })
    ).toEqual({
      x: 2070,
      y: 0
    })
  })

  it('maps a browser crop through its viewport and display offsets', () => {
    const geometry = withCaptureOffset(
      planAspectPreservingResize({ width: 1000, height: 600 }, 500),
      { x: 100, y: 80 }
    )
    const display: DisplayGeometry = {
      bounds: { x: 1440, y: 100, width: 1440, height: 900 },
      scaleFactor: 2
    }
    expect(
      imagePointToScreen({ x: 250, y: 150 }, { display, platform: 'darwin', screenshot: geometry })
    ).toEqual({
      x: 2040,
      y: 480
    })
  })

  it('fails closed for invalid image coordinates', () => {
    const geometry = planAspectPreservingResize({ width: 1000, height: 600 }, 500)
    expect(
      imagePointToScreen(
        { x: 500, y: 0 },
        { display: primary(1), platform: 'win32', screenshot: geometry }
      )
    ).toBeNull()
    expect(
      imagePointToScreen(
        { x: Number.NaN, y: 0 },
        { display: primary(1), platform: 'win32', screenshot: geometry }
      )
    ).toBeNull()
  })
})

describe('mapActionToScreen', () => {
  it('maps the point on click / double_click / right_click / scroll', () => {
    const d = primary(1.5)
    expect(
      mapActionToScreen(
        { type: 'click', point: { x: 10, y: 20 } },
        { display: d, platform: 'win32' }
      )
    ).toEqual({
      type: 'click',
      point: { x: 15, y: 30 }
    })
    expect(
      mapActionToScreen(
        { type: 'double_click', point: { x: 10, y: 20 } },
        { display: d, platform: 'win32' }
      )
    ).toEqual({ type: 'double_click', point: { x: 15, y: 30 } })
    expect(
      mapActionToScreen(
        { type: 'right_click', point: { x: 10, y: 20 } },
        { display: d, platform: 'win32' }
      )
    ).toEqual({ type: 'right_click', point: { x: 15, y: 30 } })
    expect(
      mapActionToScreen(
        { type: 'scroll', point: { x: 10, y: 20 }, direction: 'down' },
        { display: d, platform: 'win32' }
      )
    ).toEqual({ type: 'scroll', point: { x: 15, y: 30 }, direction: 'down' })
  })

  it('maps BOTH ends of a drag', () => {
    const d = primary(2) // Windows at 200%
    expect(
      mapActionToScreen(
        { type: 'drag', from: { x: 5, y: 5 }, to: { x: 50, y: 60 } },
        { display: d, platform: 'win32' }
      )
    ).toEqual({ type: 'drag', from: { x: 10, y: 10 }, to: { x: 100, y: 120 } })
  })

  it('passes coordinate-free verbs through untouched', () => {
    const d = primary(1.5)
    expect(
      mapActionToScreen({ type: 'type', content: 'hi' }, { display: d, platform: 'win32' })
    ).toEqual({
      type: 'type',
      content: 'hi'
    })
    expect(
      mapActionToScreen({ type: 'hotkey', keys: 'ctrl c' }, { display: d, platform: 'win32' })
    ).toEqual({
      type: 'hotkey',
      keys: 'ctrl c'
    })
    expect(mapActionToScreen({ type: 'wait' }, { display: d, platform: 'win32' })).toEqual({
      type: 'wait'
    })
  })

  it('is a no-op transform on macOS (points already correct)', () => {
    const d = primary(2)
    expect(
      mapActionToScreen(
        { type: 'click', point: { x: 33, y: 44 } },
        { display: d, platform: 'darwin' }
      )
    ).toEqual({
      type: 'click',
      point: { x: 33, y: 44 }
    })
  })

  it('refuses a drag when either endpoint is outside the screenshot', () => {
    const geometry = planAspectPreservingResize({ width: 1000, height: 600 }, 500)
    expect(
      mapActionToScreen(
        { type: 'drag', from: { x: 10, y: 10 }, to: { x: 500, y: 10 } },
        { display: primary(1), platform: 'win32', screenshot: geometry }
      )
    ).toBeNull()
  })
})
