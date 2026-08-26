import { safeChatExternalUrl } from '@offgrid/sync'
import { openExternal } from '../constants/links'
import { openTaskSidePanel } from './task-side-panel'

/** Open a link from Chat without turning a read into an automated Web Use task. */
export function openChatLink(href: string | null | undefined): boolean {
  const safeUrl = safeChatExternalUrl(href)
  if (!safeUrl) return false
  if (/^https?:/i.test(safeUrl) && window.api.browser?.openUrl) {
    openTaskSidePanel({ kind: 'web_use' })
    void window.api.browser.openUrl(safeUrl)
    return true
  }
  openExternal(safeUrl)
  return true
}
