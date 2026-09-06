import { describe, expect, it } from 'vitest'
import {
  alignPixelSize,
  imagePixelToDisplayPoint,
  planAspectPreservingResize,
  withCaptureOffset
} from '../screenshot-geometry'

describe('screenshot geometry', () => {
  it('resizes landscape and portrait images without changing their aspect ratio', () => {
    expect(planAspectPreservingResize({ width: 2560, height: 1440 }, 1280)).toMatchObject({
      encodedSize: { width: 1280, height: 720 },
      scale: 0.5
    })
    expect(planAspectPreservingResize({ width: 1200, height: 2400 }, 1200)).toMatchObject({
      encodedSize: { width: 600, height: 1200 },
      scale: 0.5
    })
  })

  it('does not upscale a small screenshot', () => {
    expect(planAspectPreservingResize({ width: 800, height: 600 }, 1440)).toMatchObject({
      encodedSize: { width: 800, height: 600 },
      scale: 1
    })
  })

  it('aligns UI-Mate frames to its official factor of 32', () => {
    expect(alignPixelSize({ width: 955, height: 537 }, 32)).toEqual({
      width: 960,
      height: 544
    })
  })

  it('maps an encoded browser crop through its display-local offset', () => {
    const geometry = withCaptureOffset(
      planAspectPreservingResize({ width: 1200, height: 800 }, 600),
      { x: 80, y: 120 }
    )
    expect(imagePixelToDisplayPoint({ x: 300, y: 200 }, geometry)).toEqual({ x: 680, y: 520 })
  })

  it('rejects invalid and out-of-image coordinates', () => {
    const geometry = planAspectPreservingResize({ width: 1200, height: 800 }, 600)
    expect(imagePixelToDisplayPoint({ x: -1, y: 0 }, geometry)).toBeNull()
    expect(imagePixelToDisplayPoint({ x: 600, y: 0 }, geometry)).toBeNull()
    expect(imagePixelToDisplayPoint({ x: Number.NaN, y: 0 }, geometry)).toBeNull()
  })
})
