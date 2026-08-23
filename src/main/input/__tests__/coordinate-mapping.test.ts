import { describe, expect, it } from 'vitest'
import {
  actuationScale,
  imagePointToScreen,
  mapActionToScreen,
  type DisplayGeometry
} from '../coordinate-mapping'

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
    expect(imagePointToScreen({ x: 400, y: 300 }, primary(2), 'darwin')).toEqual({ x: 400, y: 300 })
  })

  it('Windows at 100%: unchanged', () => {
    expect(imagePointToScreen({ x: 400, y: 300 }, primary(1), 'win32')).toEqual({ x: 400, y: 300 })
  })

  it('Windows at 150%: DIP is scaled to physical pixels', () => {
    // The core Windows fix: a click at DIP (400,300) on a 150% display is physical (600,450).
    expect(imagePointToScreen({ x: 400, y: 300 }, primary(1.5), 'win32')).toEqual({ x: 600, y: 450 })
  })

  it('Windows at 125%: rounds to the nearest physical pixel', () => {
    // 401 * 1.25 = 501.25 -> 501; 301 * 1.25 = 376.25 -> 376.
    expect(imagePointToScreen({ x: 401, y: 301 }, primary(1.25), 'win32')).toEqual({
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
    expect(imagePointToScreen({ x: 100, y: 200 }, secondary, 'win32')).toEqual({ x: 2711, y: 300 })
  })

  it('macOS second monitor: origin offset applies, no scaling', () => {
    const secondary: DisplayGeometry = {
      bounds: { x: 1440, y: 0, width: 1440, height: 900 },
      scaleFactor: 2
    }
    expect(imagePointToScreen({ x: 100, y: 200 }, secondary, 'darwin')).toEqual({ x: 1540, y: 200 })
  })
})

describe('mapActionToScreen', () => {
  it('maps the point on click / double_click / right_click / scroll', () => {
    const d = primary(1.5)
    expect(mapActionToScreen({ type: 'click', point: { x: 10, y: 20 } }, d, 'win32')).toEqual({
      type: 'click',
      point: { x: 15, y: 30 }
    })
    expect(
      mapActionToScreen({ type: 'double_click', point: { x: 10, y: 20 } }, d, 'win32')
    ).toEqual({ type: 'double_click', point: { x: 15, y: 30 } })
    expect(mapActionToScreen({ type: 'right_click', point: { x: 10, y: 20 } }, d, 'win32')).toEqual(
      { type: 'right_click', point: { x: 15, y: 30 } }
    )
    expect(
      mapActionToScreen({ type: 'scroll', point: { x: 10, y: 20 }, direction: 'down' }, d, 'win32')
    ).toEqual({ type: 'scroll', point: { x: 15, y: 30 }, direction: 'down' })
  })

  it('maps BOTH ends of a drag', () => {
    const d = primary(2) // Windows at 200%
    expect(
      mapActionToScreen(
        { type: 'drag', from: { x: 5, y: 5 }, to: { x: 50, y: 60 } },
        d,
        'win32'
      )
    ).toEqual({ type: 'drag', from: { x: 10, y: 10 }, to: { x: 100, y: 120 } })
  })

  it('passes coordinate-free verbs through untouched', () => {
    const d = primary(1.5)
    expect(mapActionToScreen({ type: 'type', content: 'hi' }, d, 'win32')).toEqual({
      type: 'type',
      content: 'hi'
    })
    expect(mapActionToScreen({ type: 'hotkey', keys: 'ctrl c' }, d, 'win32')).toEqual({
      type: 'hotkey',
      keys: 'ctrl c'
    })
    expect(mapActionToScreen({ type: 'wait' }, d, 'win32')).toEqual({ type: 'wait' })
  })

  it('is a no-op transform on macOS (points already correct)', () => {
    const d = primary(2)
    expect(mapActionToScreen({ type: 'click', point: { x: 33, y: 44 } }, d, 'darwin')).toEqual({
      type: 'click',
      point: { x: 33, y: 44 }
    })
  })
})
