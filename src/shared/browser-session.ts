export type BrowserSessionKind = 'manual' | 'task'
export type BrowserControl = 'back' | 'forward' | 'reload' | 'stop'
export type BrowserTaskStatus =
  | 'running'
  | 'waiting'
  | 'reconnecting'
  | 'done'
  | 'failed'
  | 'stopped'

export interface BrowserChromeState {
  url: string
  title: string
  faviconUrl?: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
}

export interface BrowserTaskPointer {
  taskId: string
  journeyId: string
  goal: string
  status: BrowserTaskStatus
  summary?: string
  steps: string[]
}

export interface BrowserSessionSnapshot extends BrowserChromeState {
  sessionId: string
  historyId?: string
  kind: BrowserSessionKind
  journeyId?: string
  parentSessionId?: string
  taskId?: string
  status: BrowserTaskPointer['status'] | 'open'
}

export interface BrowserSessionsSnapshot {
  activeSessionId: string | null
  sessions: BrowserSessionSnapshot[]
}

export interface BrowserNavigationState extends BrowserChromeState {
  sessionId: string
}

/** Web Use always gives websites one stable desktop CSS viewport. The native
 * surface is zoomed to fit its panel; responsive sites must not change layout
 * when the Off Grid AI task workspace changes size. */
export const WEB_USE_DESKTOP_VIEWPORT = { width: 1920, height: 1200 } as const
export const WEB_USE_DESKTOP_ASPECT = WEB_USE_DESKTOP_VIEWPORT

/**
 * The surfaces that can host the live page, and which one wins when both are on screen.
 *
 * There is ONE native view for the window, so its position cannot be decided by whichever renderer
 * surface reported last. Every surface that can host the page reports under its own key; main keeps
 * the latest rect per key and paints the highest-priority key still present. That makes a handover
 * atomic - the arriving surface's claim and the departing surface's release commute, so no ordering
 * between them can leave the page painting nowhere, which is what produced a blank floating card
 * and, because a hidden view captures nothing, the empty screenshots that killed running tasks.
 *
 * The docked pane outranks the floating card: when the full workspace is on screen it is the
 * surface the user is looking at, and the card is not shown at all.
 */
export type BrowserRegionOwner = 'docked' | 'floating'

export const BROWSER_REGION_PRIORITY: Record<BrowserRegionOwner, number> = {
  docked: 2,
  floating: 1
}

export function isBrowserRegionOwner(value: unknown): value is BrowserRegionOwner {
  return value === 'docked' || value === 'floating'
}

/** Electron zoom needed to fit the fixed desktop viewport into the native
 * surface while preserving the viewport's CSS dimensions. */
export function webUseDesktopZoomFactor(surface: { width: number; height: number }): number {
  return Math.min(
    surface.width / WEB_USE_DESKTOP_VIEWPORT.width,
    surface.height / WEB_USE_DESKTOP_VIEWPORT.height
  )
}

/** Fit the live Web Use page into its slot without changing the desktop
 * aspect ratio. Any unused area becomes letterboxing around the page. */
export function fitWebUseDesktopSurface(container: { width: number; height: number }): {
  width: number
  height: number
} {
  const widthFromHeight =
    (container.height * WEB_USE_DESKTOP_ASPECT.width) / WEB_USE_DESKTOP_ASPECT.height
  const width = Math.max(1, Math.min(container.width, widthFromHeight))
  return {
    width: Math.round(width),
    height: Math.round((width * WEB_USE_DESKTOP_ASPECT.height) / WEB_USE_DESKTOP_ASPECT.width)
  }
}

/** Center the fixed-aspect webpage surface inside the renderer-provided slot.
 * Main applies this too, so a renderer layout race cannot change the page's
 * desktop aspect ratio or the coordinate space used for visual actions. */
export function fitWebUseDesktopRegion(container: {
  x: number
  y: number
  width: number
  height: number
}): { x: number; y: number; width: number; height: number } {
  const surface = fitWebUseDesktopSurface(container)
  return {
    x: Math.round(container.x + (container.width - surface.width) / 2),
    y: Math.round(container.y + (container.height - surface.height) / 2),
    ...surface
  }
}

export interface BrowserPointerEvent {
  sessionId: string
  phase: 'moved' | 'pressed' | 'released'
  x: number
  y: number
}

export interface ManualBrowserHistoryEntry {
  historyId: string
  kind: 'manual'
  status: 'closed'
  title: string
  url: string
  updatedAt: number
}
