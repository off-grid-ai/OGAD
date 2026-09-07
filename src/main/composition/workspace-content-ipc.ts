/**
 * The workspace-content transport seam: one command channel and one reactive snapshot/subscription
 * channel over the Shared `workspaceContent` facade, following the pattern already used for
 * Actions (`actions-ipc.ts`) - a single owner, no local cache, no second projection.
 *
 * Registered once at composition time (below), mirroring how this module already registers its
 * own failure/health observers at load.
 */
import { BrowserWindow, ipcMain } from 'electron'
import type { WorkspaceContentCommand } from '@offgrid/application'
import { desktopWorkflows, desktopWorkspaceContent } from './application-access'

const GET_SNAPSHOT_CHANNEL = 'workspace-content:get-snapshot'
const EXECUTE_CHANNEL = 'workspace-content:execute'
const DELETE_PROJECT_CHANNEL = 'workspace-content:workflows:delete-project'
const DELETE_CONVERSATION_CHANNEL = 'workspace-content:workflows:delete-conversation'
const SNAPSHOT_CHANGED_CHANNEL = 'workspace-content:snapshot-changed'

const HANDLER_CHANNELS = [
  GET_SNAPSHOT_CHANNEL,
  EXECUTE_CHANNEL,
  DELETE_PROJECT_CHANNEL,
  DELETE_CONVERSATION_CHANNEL
] as const

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

let releaseRegistration: (() => void) | null = null

/**
 * Registers the transport seam. Idempotent: a second call while already registered returns the
 * existing disposer instead of double-handling a channel or double-subscribing the facade.
 */
export function registerWorkspaceContentIpc(): () => void {
  if (releaseRegistration) return releaseRegistration

  ipcMain.handle(GET_SNAPSHOT_CHANNEL, () => desktopWorkspaceContent.snapshot())

  ipcMain.handle(EXECUTE_CHANNEL, async (_event, command: WorkspaceContentCommand) =>
    desktopWorkspaceContent.execute(command)
  )

  ipcMain.handle(DELETE_PROJECT_CHANNEL, async (_event, projectId: unknown) => {
    if (typeof projectId !== 'string' || projectId.trim().length === 0) {
      throw new TypeError('A project ID is required.')
    }
    return desktopWorkflows.deleteProject(projectId)
  })

  ipcMain.handle(DELETE_CONVERSATION_CHANNEL, async (_event, conversationId: unknown) => {
    if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
      throw new TypeError('A conversation ID is required.')
    }
    return desktopWorkflows.deleteConversation(conversationId)
  })

  const stopSubscription = desktopWorkspaceContent.subscribe((snapshot) => {
    broadcast(SNAPSHOT_CHANGED_CHANNEL, snapshot)
  })

  releaseRegistration = function stop(): void {
    stopSubscription()
    for (const channel of HANDLER_CHANNELS) ipcMain.removeHandler(channel)
    releaseRegistration = null
  }
  return releaseRegistration
}
