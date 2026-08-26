export interface BrowserCoordinatePoint {
  x: number
  y: number
}

export interface BrowserCoordinateSize {
  width: number
  height: number
}

export interface BrowserCoordinateRect extends BrowserCoordinateSize {
  x: number
  y: number
}

export interface BrowserCoordinateFrame {
  /** Pixels in the image sent to the model after resize and patch alignment. */
  encoded: BrowserCoordinateSize
  /** CSS pixels in the complete Web Use surface, including browser controls. */
  surface: BrowserCoordinateSize
  /** Page viewport in surface-local CSS pixels. */
  page: BrowserCoordinateRect
  /** Pixels in the saved capture before inference resize. */
  capture: BrowserCoordinateSize
}

function validSize(size: BrowserCoordinateSize): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  )
}

function requireFrame(frame: BrowserCoordinateFrame): void {
  if (
    !validSize(frame.encoded) ||
    !validSize(frame.surface) ||
    !validSize(frame.page) ||
    !validSize(frame.capture) ||
    !Number.isFinite(frame.page.x) ||
    !Number.isFinite(frame.page.y)
  ) {
    throw new Error('invalid browser coordinate frame')
  }
}

function scalePoint(
  point: BrowserCoordinatePoint,
  from: BrowserCoordinateSize,
  to: BrowserCoordinateSize
): BrowserCoordinatePoint {
  return {
    x: (point.x * to.width) / from.width,
    y: (point.y * to.height) / from.height
  }
}

/**
 * The single coordinate transform for Web Use.
 *
 * Document scroll is intentionally absent. CDP pointer input is relative to
 * the visible page viewport, not to the document. Browser chrome is present in
 * the surface coordinate and is removed once by `surfaceToPage`.
 */
export function createBrowserCoordinateTransform(frame: BrowserCoordinateFrame): {
  encodedToSurface: (point: BrowserCoordinatePoint) => BrowserCoordinatePoint
  surfaceToPage: (point: BrowserCoordinatePoint) => BrowserCoordinatePoint
  surfaceToCapture: (point: BrowserCoordinatePoint) => BrowserCoordinatePoint
  surfaceToCapturePercent: (point: BrowserCoordinatePoint) => BrowserCoordinatePoint
} {
  requireFrame(frame)
  return {
    encodedToSurface: (point) => {
      const mapped = scalePoint(point, frame.encoded, frame.surface)
      return { x: Math.round(mapped.x), y: Math.round(mapped.y) }
    },
    surfaceToPage: (point) => ({
      x: point.x - frame.page.x,
      y: point.y - frame.page.y
    }),
    surfaceToCapture: (point) => scalePoint(point, frame.surface, frame.capture),
    surfaceToCapturePercent: (point) => {
      const capturePoint = scalePoint(point, frame.surface, frame.capture)
      return {
        x: (capturePoint.x * 100) / frame.capture.width,
        y: (capturePoint.y * 100) / frame.capture.height
      }
    }
  }
}
