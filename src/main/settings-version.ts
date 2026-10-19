// A number that moves whenever something a paired browser's Settings screens show may have
// changed: a saved setting, the active model, an installed or removed model, a remote server.
//
// The browser used to re-read every open Settings section every five seconds, and a text read
// rebuilds the model catalogue and parses GGUF headers on the main thread. Instead it now holds
// one `settings.watch` request open and re-reads only when this version moves. Writers call
// settingsChanged(); nothing here knows what changed, so a missed writer costs a stale screen
// until the panel is focused again, never a wrong value.
//
// A leaf module on purpose: database, model and settings writers import it without cycles.

/** Starts at the clock so a restarted desktop never repeats a version a browser has seen. */
let version = Date.now()
const waiters = new Set<() => void>()

export function settingsVersion(): number {
  return version
}

export function settingsChanged(): void {
  version += 1
  const ready = [...waiters]
  waiters.clear()
  for (const wake of ready) wake()
}

/**
 * The current version, as soon as it differs from `since`; otherwise when it next changes or
 * when `timeoutMs` passes, whichever is first. A timeout answers with the same version, so the
 * caller simply asks again.
 */
export function nextSettingsVersion(since: number | undefined, timeoutMs: number): Promise<number> {
  if (since !== version) return Promise.resolve(version)
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer)
      waiters.delete(wake)
      resolve(version)
    }
    const timer = setTimeout(wake, timeoutMs)
    waiters.add(wake)
  })
}
