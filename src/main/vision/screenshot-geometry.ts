import type { Point } from './vision-action'

export interface PixelSize {
  width: number
  height: number
}

/** The encoded image maps to this rectangle in display-local DIP coordinates.
 * A full-display capture starts at (0,0). A browser/window crop supplies its
 * viewport offset here, so coordinate conversion has one explicit owner. */
export interface ScreenshotGeometry {
  sourceBounds: { x: number; y: number; width: number; height: number }
  encodedSize: PixelSize
  scale: number
}

function validSize(size: PixelSize): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  )
}

export function planAspectPreservingResize(source: PixelSize, maxEdge: number): ScreenshotGeometry {
  if (!validSize(source) || !Number.isFinite(maxEdge) || maxEdge < 1) {
    throw new Error('invalid screenshot dimensions')
  }
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height))
  return {
    sourceBounds: { x: 0, y: 0, width: source.width, height: source.height },
    encodedSize: {
      width: Math.max(1, Math.round(source.width * scale)),
      height: Math.max(1, Math.round(source.height * scale))
    },
    scale
  }
}

export function withCaptureOffset(geometry: ScreenshotGeometry, offset: Point): ScreenshotGeometry {
  if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) {
    throw new Error('invalid capture offset')
  }
  return {
    ...geometry,
    sourceBounds: { ...geometry.sourceBounds, x: offset.x, y: offset.y }
  }
}

/** Convert an encoded-image pixel to display-local DIP. Invalid or out-of-image
 * model coordinates fail closed instead of being actuated off-screen. */
export function imagePixelToDisplayPoint(point: Point, geometry: ScreenshotGeometry): Point | null {
  const { encodedSize, sourceBounds } = geometry
  if (
    !validSize(encodedSize) ||
    !Number.isFinite(sourceBounds.x) ||
    !Number.isFinite(sourceBounds.y) ||
    !Number.isFinite(sourceBounds.width) ||
    !Number.isFinite(sourceBounds.height) ||
    sourceBounds.width <= 0 ||
    sourceBounds.height <= 0 ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= encodedSize.width ||
    point.y >= encodedSize.height
  ) {
    return null
  }
  return {
    x: sourceBounds.x + (point.x / encodedSize.width) * sourceBounds.width,
    y: sourceBounds.y + (point.y / encodedSize.height) * sourceBounds.height
  }
}
