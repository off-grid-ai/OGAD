/**
 * Map a vision/grounder click point to the coordinate the synthetic-input addon
 * (nut.js) must be handed. Pure + platform-parameterised so it is testable off a
 * real display (the actuation itself is not).
 *
 * The screenshot is captured at the display's `size` (DIP/logical pixels), so the
 * grounder's denormalised point is in DIP space relative to that display's
 * top-left. What nut.js expects differs by OS, and this is the ONE place that
 * difference lives:
 *
 *  - macOS: Quartz/CGEvent positions the cursor in POINTS (DIP). Retina's 2x is
 *    transparent, so the DIP point is used as-is (only offset by the display
 *    origin, which matters once there is a second monitor). This is why the
 *    coordinate historically went through raw and mac still worked.
 *  - Windows: a per-monitor-DPI-aware process (modern Electron) positions the
 *    cursor in PHYSICAL pixels (SetCursorPos), so a DIP point on a 125%/150%
 *    display must be multiplied by that display's scaleFactor. Without it every
 *    click on a scaled Windows display lands short - the core Windows gap.
 *
 * On mixed-DPI Windows displays the caller supplies the physical origin resolved
 * through Electron's dipToScreenPoint seam. This avoids the incorrect shortcut of
 * multiplying a global DIP origin by one display's scale factor.
 */
import type { Point, VisionAction } from '../vision/vision-action'
import { imagePixelToDisplayPoint, type ScreenshotGeometry } from '../vision/screenshot-geometry'

export interface DisplayGeometry {
  /** Display origin + size in DIP - Electron `screen.getDisplayNearestPoint().bounds`. */
  bounds: { x: number; y: number; width: number; height: number }
  /** DIP -> physical ratio for this display (1 on a standard-DPI monitor, 1.5 at 150%). */
  scaleFactor: number
  /** Optional physical-pixel origin. Supply this for mixed-DPI Windows displays,
   * where multiplying Electron's global DIP origin is not correct. */
  physicalOrigin?: Point
}

export interface CoordinateMappingContext {
  display: DisplayGeometry
  platform: NodeJS.Platform
  screenshot?: ScreenshotGeometry
}

/** The DIP->actuation scale for a platform: only Windows needs it; macOS uses points. */
export function actuationScale(platform: NodeJS.Platform, scaleFactor: number): number {
  return platform === 'win32' ? scaleFactor : 1
}

/** Map ONE point in the captured image's DIP space to the OS cursor coordinate. */
export function imagePointToScreen(point: Point, context: CoordinateMappingContext): Point | null {
  const { display, platform, screenshot } = context
  const local = screenshot ? imagePixelToDisplayPoint(point, screenshot) : point
  if (
    !local ||
    !Number.isFinite(local.x) ||
    !Number.isFinite(local.y) ||
    !Number.isFinite(display.bounds.x) ||
    !Number.isFinite(display.bounds.y) ||
    !Number.isFinite(display.scaleFactor) ||
    display.scaleFactor <= 0
  ) {
    return null
  }
  const scale = actuationScale(platform, display.scaleFactor)
  const origin =
    platform === 'win32' && display.physicalOrigin
      ? display.physicalOrigin
      : { x: display.bounds.x * scale, y: display.bounds.y * scale }
  return {
    x: Math.round(origin.x + local.x * scale),
    y: Math.round(origin.y + local.y * scale)
  }
}

/** Return a copy of the action with every coordinate moved into the actuation space.
 *  Verbs without coordinates (type/hotkey/wait/finished/call_user) pass through. */
export function mapActionToScreen(
  action: VisionAction,
  context: CoordinateMappingContext
): VisionAction | null {
  const map = (point: Point): Point | null => imagePointToScreen(point, context)
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'scroll': {
      const point = map(action.point)
      return point ? { ...action, point } : null
    }
    case 'drag': {
      const from = map(action.from)
      const to = map(action.to)
      return from && to ? { ...action, from, to } : null
    }
    default:
      return action
  }
}
