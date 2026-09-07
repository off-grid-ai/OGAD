import { BrowserWindow } from 'electron'

export interface RagConversationChange {
  conversationId: string
  projectId?: string | null
}

/** Tell every renderer to reload one durable Chat conversation. */
export function notifyRagConversationChanged(change: RagConversationChange): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('rag:conversations-changed', change)
  }
}
