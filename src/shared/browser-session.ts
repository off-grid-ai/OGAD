/**
 * TEMPORARY re-export shim (hexagonal program 2, seat C). Owner: `@offgrid/automation`
 * (`web-use-surface`: the fixed desktop viewport, fit/zoom, region owner priority, session and task
 * pointer types). Delete when every importer listed under this shim in
 * shared/docs/hexagonal-program-2/PROGRESS_C.md imports `@offgrid/automation` directly; Agent A
 * flips the renderer, preload, and pro importers in the same cutover.
 */
export {
  WEB_USE_DESKTOP_VIEWPORT,
  WEB_USE_DESKTOP_ASPECT,
  BROWSER_REGION_PRIORITY,
  isBrowserRegionOwner,
  webUseDesktopZoomFactor,
  fitWebUseDesktopSurface,
  fitWebUseDesktopRegion,
  type BrowserSessionKind,
  type BrowserControl,
  type BrowserTaskStatus,
  type BrowserChromeState,
  type BrowserTaskPointer,
  type BrowserSessionSnapshot,
  type BrowserSessionsSnapshot,
  type BrowserNavigationState,
  type BrowserRegionOwner,
  type BrowserPointerEvent,
  type ManualBrowserHistoryEntry
} from '@offgrid/automation'
