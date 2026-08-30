/**
 * Which app does a computer_use target? (R5 T1d, pure half.)
 *
 * The accessibility rail reads and drives ONE named app, so before it can run it
 * has to decide which. The Off Grid AI window is frontmost the instant the user
 * approves the task, so "the frontmost app" is the wrong answer - it would read
 * Off Grid AI's own controls. Instead the target is the app the goal NAMES that is
 * actually running: "message sidd on Slack" while Slack is open -> Slack.
 *
 * Pure and injected (the goal text + the running app names) so the match rule is
 * unit-tested; the host does the get-windows I/O and hands the names in. When
 * nothing matches, the caller falls through to vision (which sees the whole
 * screen and needs no app name).
 */

/** The app the goal targets, or null when the goal names no running app. Picks
 *  the LONGEST-named match so "Slack" beats a stray substring, and never targets
 *  Off Grid AI itself. */
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
