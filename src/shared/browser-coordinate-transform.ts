/**
 * TEMPORARY re-export shim (hexagonal program 2, seat C). Owner: `@offgrid/automation`
 * (`web-use-coordinates`). Delete when `browser-vision-screen.ts` imports `@offgrid/automation`
 * directly (C, with the browser cutover).
 */
export {
  createBrowserCoordinateTransform,
  type BrowserCoordinateFrame,
  type CoordinatePoint as BrowserCoordinatePoint,
  type CoordinateSize as BrowserCoordinateSize,
  type CoordinateRect as BrowserCoordinateRect
} from '@offgrid/automation'
