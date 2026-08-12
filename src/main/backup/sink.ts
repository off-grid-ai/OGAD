import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type { BackupSink } from '@offgrid/sync/portable'

export interface DesktopBackupDelivery {
  canceled: boolean
  path?: string
}

export class DesktopBackupSink implements BackupSink<DesktopBackupDelivery> {
  async deliverFile(absPath: string, suggestedName: string): Promise<DesktopBackupDelivery> {
    try {
      const options: Electron.SaveDialogOptions = {
        title: 'Export Off Grid backup',
        defaultPath: suggestedName,
        filters: [{ name: 'Off Grid backup', extensions: ['zip'] }]
      }
      const owner = BrowserWindow.getFocusedWindow()
      const result = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { canceled: true }
      await fs.promises.copyFile(absPath, result.filePath)
      return { canceled: false, path: result.filePath }
    } finally {
      await fs.promises.rm(absPath, { force: true })
      await fs.promises.rmdir(path.dirname(absPath)).catch(() => undefined)
    }
  }

  async pickFile(): Promise<string | null> {
    const options: Electron.OpenDialogOptions = {
      title: 'Import Off Grid backup',
      properties: ['openFile'],
      filters: [{ name: 'Off Grid backup', extensions: ['zip'] }]
    }
    const owner = BrowserWindow.getFocusedWindow()
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
}
