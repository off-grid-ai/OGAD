import { safeChatExternalUrl } from '@offgrid/application'
import { openExternal } from '../constants/links'
import { openTaskSidePanel } from './task-side-panel'
import { getActiveConversationId } from './active-conversation'

/** Open a link from Chat without turning a read into an automated Web Use task. */
export function openChatLink(href: string | null | undefined): boolean {
  const safeUrl = safeChatExternalUrl(href)
  if (!safeUrl) return false
  if (/^https?:/i.test(safeUrl) && window.api.browser?.openUrl) {
    openTaskSidePanel({ kind: 'web_use' })
    // Bind the page to the current chat so it docks here and does not leak into
    // other conversations (the docked pane scopes manual tabs by journeyId).
    void window.api.browser.openUrl(safeUrl, getActiveConversationId() ?? undefined)
    return true
  }
  openExternal(safeUrl)
  return true
}
