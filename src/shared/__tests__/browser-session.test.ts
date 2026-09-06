import { describe, expect, it } from 'vitest'
import {
  fitWebUseDesktopRegion,
  fitWebUseDesktopSurface,
  WEB_USE_DESKTOP_VIEWPORT,
  webUseDesktopZoomFactor
} from '../browser-session'

describe('Web Use desktop surface', () => {
  it('letterboxes a tall task panel at the standard desktop aspect ratio', () => {
    expect(fitWebUseDesktopSurface({ width: 800, height: 900 })).toEqual({
      width: 800,
      height: 500
    })
  })

  it('letterboxes a wide task panel at the standard desktop aspect ratio', () => {
    expect(fitWebUseDesktopSurface({ width: 1600, height: 800 })).toEqual({
      width: 1280,
      height: 800
    })
  })

  it('centers the fixed desktop surface inside the reported native slot', () => {
    expect(fitWebUseDesktopRegion({ x: 100, y: 40, width: 800, height: 900 })).toEqual({
      x: 100,
      y: 240,
      width: 800,
      height: 500
    })
  })

  it('keeps the full-size desktop viewport at 100 percent', () => {
    expect(webUseDesktopZoomFactor(WEB_USE_DESKTOP_VIEWPORT)).toBe(1)
  })

  it('scales the same desktop viewport into a smaller 16:10 panel', () => {
    expect(webUseDesktopZoomFactor({ width: 960, height: 600 })).toBe(0.5)
  })
})
