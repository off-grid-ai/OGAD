// IPC surface for projects + RAG (knowledge bases) + project chat. Kept separate
// from the large ipc.ts. Registered from main/index.ts via setupRagIPC().

import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import { randomUUID } from 'node:crypto'
import { listProjects, createProject, updateProject, deleteProject } from './rag'
import { desktopRag } from './composition/application-access'
import { desktopApplication } from './composition/application'
import { requireApplicationOutcome } from './composition/application-outcome'
import { attachmentPickerExtensions } from '@offgrid/sync'
import { workflowFailureMessage } from '@offgrid/application'

// Built from the shared attachment classifier (@offgrid/sync) so the picker allowlist
// and the processor can never drift: it used to hardcode a subset that omitted
// gif/bmp/heic/opus/aiff/avi the router actually handles.
const DOC_FILTERS = [{ name: 'Documents, audio & video', extensions: attachmentPickerExtensions() }]

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

  ipcMain.handle('projects:delete', async (_e, id: string) => {
    // The workflow owns the cross-domain cleanup (RAG index, then sync). Its failure is the
    // reason it exists: deleting the local row after a partial cleanup destroys the only
    // record of what still has to be cleaned up, so the typed failure stops the delete and
    // reaches the caller instead of being dropped.
    const cleanup = await desktopApplication.workflows.deleteProject(id)
    if (!cleanup.ok) throw new Error(workflowFailureMessage(cleanup.failure))
    deleteProject(id)
  })

  // --- Knowledge base (documents) ------------------------------------------
  ipcMain.handle('projects:list-documents', async (_e, projectId: string) =>
    requireApplicationOutcome(await desktopRag.listDocuments(projectId))
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
      try {
        const size = fs.statSync(filePath).size
        const indexed = await desktopRag.addDocument(
          { projectId, path: filePath, fileName: name, size },
          (stage) => {
            e.sender.send('projects:index-progress', { projectId, name, stage })
          }
        )
        requireApplicationOutcome(indexed)
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

  ipcMain.handle('projects:toggle-document', async (_e, docId: number, enabled: boolean) =>
    requireApplicationOutcome(await desktopRag.setDocumentEnabled(docId, enabled))
  )

  ipcMain.handle('projects:delete-document', async (_e, docId: number) =>
    requireApplicationOutcome(await desktopRag.removeDocument(docId))
  )
}
