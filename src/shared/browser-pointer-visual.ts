import { COLORS_DARK, COLORS_LIGHT } from '@offgrid/design'

/** One Codex-style automation pointer for both the injected BrowserView DOM and
 * the renderer fallback. Geometry follows the local Codex MousePointer asset;
 * Off Grid AI tokens own its contrast and action accent. */
export const BROWSER_POINTER_VISUAL = {
  viewBox: '0 0 24 24',
  width: 20,
  height: 20,
  hotspotX: 3,
  hotspotY: 3,
  fill: COLORS_DARK.background,
  stroke: COLORS_LIGHT.background,
  strokeWidth: 1.75,
  action: COLORS_DARK.primary,
  glow: COLORS_LIGHT.primary,
  paths: [
    'M12.586 12.586 19 19',
    'M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z'
  ]
} as const

/**
 * The pointer as a CSS `background-image` value.
 *
 * A background image, not markup, because the cursor is injected into ARBITRARY pages and the
 * previous version assigned it with `innerHTML` - which is a Trusted Types sink. Any page serving
 * `require-trusted-types-for 'script'` (every Google property, so google.com/travel/flights, where
 * this was reported) throws a TypeError on that assignment, aborting the whole injection before the
 * element was ever mounted. That is why the cursor was missing from the live view AND from captured
 * screenshots. CSS is not a sink, so this cannot be blocked.
 *
 * The svg is sized 100%, so it fills whatever box the caller gives it: the injected cursor is
 * counter-scaled against page zoom, and a fixed width/height inside the svg would have ignored that.
 */
export function browserPointerBackgroundImage(): string {
  const paths = BROWSER_POINTER_VISUAL.paths
    .map(
      (path) =>
        `<path d="${path}" fill="${BROWSER_POINTER_VISUAL.fill}" stroke="${BROWSER_POINTER_VISUAL.stroke}" stroke-width="${BROWSER_POINTER_VISUAL.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
    )
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BROWSER_POINTER_VISUAL.viewBox}" width="100%" height="100%">${paths}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}
