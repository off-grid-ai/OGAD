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

export function browserPointerSvgMarkup(): string {
  const paths = BROWSER_POINTER_VISUAL.paths
    .map(
      (path) =>
        `<path d="${path}" fill="${BROWSER_POINTER_VISUAL.fill}" stroke="${BROWSER_POINTER_VISUAL.stroke}" stroke-width="${BROWSER_POINTER_VISUAL.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
    )
    .join('')
  return `<svg viewBox="${BROWSER_POINTER_VISUAL.viewBox}" width="${BROWSER_POINTER_VISUAL.width}" height="${BROWSER_POINTER_VISUAL.height}" aria-hidden="true">${paths}</svg>`
}
