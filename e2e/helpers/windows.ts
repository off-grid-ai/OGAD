import { expect, type ElectronApplication, type Page } from '@playwright/test'

/** The app's main window. Pro also opens utility windows (the clipboard popup, the Computer Use
 *  supervisor, AI activity), and after a relaunch one of those can be the first to appear. */
export const mainWindow = async (running: ElectronApplication): Promise<Page> => {
  await running.firstWindow()
  let found: Page | undefined
  await expect
    .poll(
      async () => {
        found = running.windows().find((candidate) => {
          const url = candidate.url()
          return url && !/#(clip-popup|cu-supervisor|ai-activity)|overlay/.test(url)
        })
        return found !== undefined
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  await found!.waitForLoadState('domcontentloaded')
  return found!
}

/** Close the app and wait for its process to exit. A launch before that loses the single-instance
 *  lock and quits at once. */
export const closeAndWait = async (running: ElectronApplication): Promise<void> => {
  const child = running.process()
  const exited =
    child.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await running.close().catch(() => undefined)
  await exited
}

/** Go to a screen through the sidebar, as a person does. */
export const gotoScreen = async (page: Page, name: string): Promise<void> => {
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click()
}
