// The browser tab a paired browser offered for a web task: the chat's tab, so the task works where
// the user is. It travels inside that one task's action arguments, set by the extension bridge
// and read when the task starts, so two chats in one browser never trade tabs, however their
// tasks queue. Mirrors the extension's start-tab.ts, whose fence lets the desktop take that tab
// (socket op tab.adopt). Pure.

export interface StartTab {
  /** The paired browser whose tab this is: the task must run over that browser's link. */
  readonly browserId: string
  readonly tabId: number
}

const BROWSER_ARG = '__offgridStartBrowserId'
const TAB_ARG = '__offgridStartTabId'

/** Task arguments carrying `tab`, and never a start tab the model wrote itself. */
export function actionArgsWithStartTab(
  args: Record<string, unknown>,
  tab?: StartTab
): Record<string, unknown> {
  const clean = { ...args }
  delete clean[BROWSER_ARG]
  delete clean[TAB_ARG]
  return tab ? { ...clean, [BROWSER_ARG]: tab.browserId, [TAB_ARG]: tab.tabId } : clean
}

/** The tab a task's arguments carry, or null. */
export function startTabFromActionArgs(args: unknown): StartTab | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const fields = args as Record<string, unknown>
  const browserId = typeof fields[BROWSER_ARG] === 'string' ? fields[BROWSER_ARG] : ''
  const tabId = fields[TAB_ARG]
  return browserId && typeof tabId === 'number' && Number.isSafeInteger(tabId) && tabId >= 0
    ? { browserId, tabId }
    : null
}
