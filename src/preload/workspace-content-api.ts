import { ipcRenderer } from 'electron'
import type {
  Outcome,
  WorkflowFailure,
  WorkspaceContentCommand,
  WorkspaceContentOutcome,
  WorkspaceContentSnapshot
} from '@offgrid/application'
import type { DesktopWorkspaceContentMigrationSnapshot } from '../main/workspace-content/migration-runtime'

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const workspaceContentApi = {
  getSnapshot: (): Promise<WorkspaceContentSnapshot> =>
    ipcRenderer.invoke('workspace-content:get-snapshot'),
  execute: (command: WorkspaceContentCommand): Promise<WorkspaceContentOutcome> =>
    ipcRenderer.invoke('workspace-content:execute', command),
  onSnapshot: (callback: (snapshot: WorkspaceContentSnapshot) => void): (() => void) =>
    subscribe('workspace-content:snapshot-changed', callback),
  workflows: {
    deleteProject: (projectId: string): Promise<Outcome<void, WorkflowFailure>> =>
      ipcRenderer.invoke('workspace-content:workflows:delete-project', projectId),
    deleteConversation: (conversationId: string): Promise<Outcome<void, WorkflowFailure>> =>
      ipcRenderer.invoke('workspace-content:workflows:delete-conversation', conversationId)
  },
  migration: {
    getSnapshot: (): Promise<DesktopWorkspaceContentMigrationSnapshot> =>
      ipcRenderer.invoke('workspace-content:migration:get-snapshot'),
    retry: (): Promise<DesktopWorkspaceContentMigrationSnapshot> =>
      ipcRenderer.invoke('workspace-content:migration:retry'),
    onSnapshot: (
      callback: (snapshot: DesktopWorkspaceContentMigrationSnapshot) => void
    ): (() => void) => subscribe('workspace-content:migration:snapshot-changed', callback)
  }
}
