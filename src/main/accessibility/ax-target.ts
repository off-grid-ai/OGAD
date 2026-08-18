/**
 * Which app does a computer_task target? (R5 T1d, pure half.)
 *
 * The accessibility rail reads and drives ONE named app, so before it can run it
 * has to decide which. The Off Grid window is frontmost the instant the user
 * approves the task, so "the frontmost app" is the wrong answer - it would read
 * Off Grid's own controls. Instead the target is the app the goal NAMES that is
 * actually running: "message sidd on Slack" while Slack is open -> Slack.
 *
 * Pure and injected (the goal text + the running app names) so the match rule is
 * unit-tested; the host does the get-windows I/O and hands the names in. When
 * nothing matches, the caller falls through to vision (which sees the whole
 * screen and needs no app name).
 */

/** The app the goal targets, or null when the goal names no running app. Picks
 *  the LONGEST-named match so "Slack" beats a stray substring, and never targets
 *  Off Grid itself. */
export function pickTargetApp(
  goal: string,
  runningApps: readonly string[],
  selfName: string
): string | null {
  const haystack = goal.toLowerCase()
  const self = selfName.toLowerCase()
  let best: string | null = null
  for (const app of runningApps) {
    const name = app.trim()
    // A one-letter app name matches almost any goal; require real specificity.
    if (name.length < 2) {
      continue
    }
    if (name.toLowerCase() === self) {
      continue
    }
    if (!haystack.includes(name.toLowerCase())) {
      continue
    }
    if (best === null || name.length > best.length) {
      best = name
    }
  }
  return best
}

/** Browsers the AX rail can drive for a WEB computer_task, most-preferred first.
 *  Used only as a fallback: an orchestrator "play/watch X" plan opens the user's
 *  browser with open_url, then runs a computer_task to click the result - but
 *  that goal ("click the first video") names no app, so pickTargetApp finds
 *  nothing. This lets it target the browser we just opened. */
export const BROWSER_APPS = [
  'Arc',
  'Google Chrome',
  'Google Chrome Canary',
  'Microsoft Edge',
  'Brave Browser',
  'Safari',
  'Firefox',
  'Opera',
  'Vivaldi'
] as const

/** Does the goal describe acting on a web page? Gates the browser fallback so a
 *  non-web goal ("click send" in a chat app) is never hijacked to a running
 *  browser - only an explicitly web goal falls back to the browser. */
export function isWebGoal(goal: string): boolean {
  return /\b(video|youtube|browser|website|web ?page|the page|the site|a tab|search results?|results page|watch|play\b[^.]*\bon\b)\b/i.test(
    goal
  )
}

/** The app a computer_task should drive: the app the goal NAMES, else - for a
 *  web goal only - the running browser (the one a preceding open_url opened).
 *  Preserves the named-app behaviour; adds the browser fallback the orchestrator
 *  chain needs so the AX rail can click a video in the user's real browser. */
export function pickWebTarget(
  goal: string,
  runningApps: readonly string[],
  selfName: string
): string | null {
  const named = pickTargetApp(goal, runningApps, selfName)
  if (named) {
    return named
  }
  if (!isWebGoal(goal)) {
    return null
  }
  const running = new Set(runningApps.map((a) => a.trim()))
  return BROWSER_APPS.find((b) => running.has(b)) ?? null
}
