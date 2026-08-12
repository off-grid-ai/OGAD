// IPC surface for projects + RAG (knowledge bases) + project chat. Kept separate
// from the large ipc.ts. Registered from main/index.ts via setupRagIPC().

import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import { randomUUID } from 'node:crypto'
import { ragService, listProjects, createProject, updateProject, deleteProject } from './rag'
import { uploadPickerExtensions } from './files-classify'

// Built from the router's classify sets (files-classify) so the picker allowlist
// and the processor can never drift: it used to hardcode a subset that omitted
// gif/bmp/heic/opus/aiff/avi the router actually handles.
const DOC_FILTERS = [{ name: 'Documents, audio & video', extensions: uploadPickerExtensions() }]

export function setupRagIPC(): void {
  // --- Projects -------------------------------------------------------------
  ipcMain.handle('projects:list', () => listProjects())

  ipcMain.handle(
    'projects:create',
    (_e, p: { name: string; description?: string; systemPrompt?: string; icon?: string }) => {
      const id = randomUUID()
      createProject({ id, ...p })
      return id
    }
  )

  ipcMain.handle('projects:update', (_e, id: string, patch: Record<string, unknown>) => {
    updateProject(id, patch)
  })

  ipcMain.handle('projects:delete', (_e, id: string) => deleteProject(id))

  // --- Knowledge base (documents) ------------------------------------------
  ipcMain.handle('projects:list-documents', (_e, projectId: string) =>
    ragService.listDocuments(projectId)
  )

  ipcMain.handle('projects:add-documents', async (e, projectId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Add to knowledge base',
      properties: ['openFile', 'multiSelections'],
      filters: DOC_FILTERS
    })
    if (result.canceled || result.filePaths.length === 0) return { added: 0 }

    let added = 0
    for (const filePath of result.filePaths) {
      const name = filePath.split('/').pop() ?? filePath
      let size = 0
      try {
        size = fs.statSync(filePath).size
      } catch {
        /* ignore */
      }
      try {
        await ragService.indexDocument(
          { projectId, path: filePath, fileName: name, size },
          (stage) => {
            e.sender.send('projects:index-progress', { projectId, name, stage })
          }
        )
        added++
      } catch (err) {
        e.sender.send('projects:index-progress', {
          projectId,
          name,
          stage: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return { added }
  })

  ipcMain.handle('projects:toggle-document', (_e, docId: number, enabled: boolean) =>
    ragService.toggleDocument(docId, enabled)
  )

  ipcMain.handle('projects:delete-document', (_e, docId: number) =>
    ragService.deleteDocument(docId)
  )
}
