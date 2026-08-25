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
 * Limitation: on a mixed-DPI multi-monitor Windows setup the physical origin of a
 * secondary display is not simply its DIP origin x scaleFactor, so a click routed
 * to a secondary display with a different scale can be offset. Single-display (any
 * scale) and same-scale multi-monitor are correct; mixed-DPI multi-monitor is a
 * follow-up (needs a physical-bounds source Electron does not expose directly).
 */
import type { Point, VisionAction } from '../vision/vision-action'

export interface DisplayGeometry {
  /** Display origin + size in DIP - Electron `screen.getDisplayNearestPoint().bounds`. */
  bounds: { x: number; y: number; width: number; height: number }
  /** DIP -> physical ratio for this display (1 on a standard-DPI monitor, 1.5 at 150%). */
  scaleFactor: number
}

/** The DIP->actuation scale for a platform: only Windows needs it; macOS uses points. */
export function actuationScale(platform: NodeJS.Platform, scaleFactor: number): number {
  return platform === 'win32' ? scaleFactor : 1
}

/** Map ONE point in the captured image's DIP space to the OS cursor coordinate. */
export function imagePointToScreen(
  point: Point,
  display: DisplayGeometry,
  platform: NodeJS.Platform
): Point {
  const scale = actuationScale(platform, display.scaleFactor)
  return {
    x: Math.round((display.bounds.x + point.x) * scale),
    y: Math.round((display.bounds.y + point.y) * scale)
  }
}

/** Return a copy of the action with every coordinate moved into the actuation space.
 *  Verbs without coordinates (type/hotkey/wait/finished/call_user) pass through. */
export function mapActionToScreen(
  action: VisionAction,
  display: DisplayGeometry,
  platform: NodeJS.Platform
): VisionAction {
  const map = (p: Point): Point => imagePointToScreen(p, display, platform)
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'scroll':
      return { ...action, point: map(action.point) }
    case 'drag':
      return { ...action, from: map(action.from), to: map(action.to) }
    default:
      return action
  }
}
