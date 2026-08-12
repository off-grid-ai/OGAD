/**
 * Whether this launch puts its windows on screen.
 *
 * The e2e suite drives the REAL app through Playwright, and Playwright has no headless option for
 * Electron - `headless` applies to browsers it launches itself, while an Electron app creates its own
 * BrowserWindows. On Linux CI that is invisible because xvfb hands the run a throwaway display. On a
 * developer's Mac there is no such thing: every `npm run test:e2e` (and so every pre-push) opened a
 * maximized window per spec and took the keyboard away from whatever the developer was doing, ~25
 * times in a row. The previous answer was to skip the gate locally with OFFGRID_SKIP_E2E=1, which
 * bought quiet by not running the tests.
 *
 * A window is not needed for any of it. The renderer loads, paints and answers CDP whether or not the
 * window is mapped - Playwright talks to the webContents, not to the screen - so a headless run here
 * means simply never calling show(), and keeping the app out of the Dock so it cannot become the
 * frontmost application either.
 *
 * Two variables rather than one, because "always hidden" would make the suite undebuggable:
 *
 *   OFFGRID_E2E_HEADLESS=1   the run is headless (set by `npm run test:e2e`, inherited by every
 *                            launch because each spec spreads process.env)
 *   OFFGRID_E2E_HEADED=1     watch it happen anyway - wins over the above
 *
 * Absent both, this returns the normal presentation, so a real user's app is untouched by any of it.
 */
export interface WindowPresentation {
  /** Call show() once the renderer has painted. */
  readonly showWindow: boolean
  /** Keep the app in the Dock and the app switcher. */
  readonly showInDock: boolean
}

const VISIBLE: WindowPresentation = { showWindow: true, showInDock: true }
const HEADLESS: WindowPresentation = { showWindow: false, showInDock: false }

export function resolveWindowPresentation(
  env: Readonly<Record<string, string | undefined>>
): WindowPresentation {
  if (env.OFFGRID_E2E_HEADED === '1') return VISIBLE
  return env.OFFGRID_E2E_HEADLESS === '1' ? HEADLESS : VISIBLE
}
