import { app, dialog, ipcMain } from 'electron'
import { SYNC_PORTABLE_CHANNELS } from '../../shared/sync-portable-contract'
import { getDB } from '../database'
import { DesktopPortableService } from './service'
import { boundedId, collisionPolicy } from './ipc-validation'

export function setupSyncPortableIpc(): void {
  const service = new DesktopPortableService({
    userData: app.getPath('userData'),
    database: getDB(),
    dialogs: {
      async saveWorkspace(suggestedName) {
        const result = await dialog.showSaveDialog({
          title: 'Save your Off Grid AI workspace',
          defaultPath: suggestedName,
          filters: [{ name: 'Off Grid AI workspace', extensions: ['zip'] }]
        })
        return result.canceled ? null : result.filePath
      },
      async pickWorkspace() {
        const result = await dialog.showOpenDialog({
          title: 'Open an Off Grid AI workspace',
          properties: ['openFile'],
          filters: [{ name: 'Off Grid AI workspace', extensions: ['zip'] }]
        })
        return result.canceled ? null : (result.filePaths[0] ?? null)
      }
    }
  })

  ipcMain.handle(SYNC_PORTABLE_CHANNELS.exportAll, () => service.exportAll())
  ipcMain.handle(SYNC_PORTABLE_CHANNELS.exportProject, (_event, projectId: unknown) =>
    service.exportProject(boundedId(projectId, 'Project ID'))
  )
  ipcMain.handle(SYNC_PORTABLE_CHANNELS.exportConversation, (_event, conversationId: unknown) =>
    service.exportConversation(boundedId(conversationId, 'Conversation ID'))
  )
  ipcMain.handle(SYNC_PORTABLE_CHANNELS.importPicker, (_event, policy: unknown) =>
    service.importPicker(collisionPolicy(policy))
  )
}
