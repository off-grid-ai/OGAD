// IPC surface for projects + RAG (knowledge bases) + project chat. Kept separate
// from the large ipc.ts. Registered from main/index.ts via setupRagIPC().

import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import { desktopRag } from './composition/application-access'
import { requireApplicationOutcome } from './composition/application-outcome'
import { attachmentPickerExtensions } from '@offgrid/sync'
import {
  PROJECT_DOCUMENTS_CHANGED_CHANNEL,
  PROJECT_INDEX_PROGRESS_CHANNEL,
  type ProjectDocumentsChangedContract,
  type ProjectIndexProgressContract
} from '../shared/ipc-contracts'

// Built from the shared attachment classifier (@offgrid/sync) so the picker allowlist
// and the processor can never drift: it used to hardcode a subset that omitted
// gif/bmp/heic/opus/aiff/avi the router actually handles.
const DOC_FILTERS = [{ name: 'Documents, audio & video', extensions: attachmentPickerExtensions() }]

let releaseDocumentProjection: (() => void) | null = null

function publishProjectDocumentsChanged(projectId: string): void {
  const payload: ProjectDocumentsChangedContract = { projectId }
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(PROJECT_DOCUMENTS_CHANGED_CHANNEL, payload)
  }
}

function observeDocumentProjection(): () => void {
  releaseDocumentProjection?.()
  const release = desktopRag.events((event) => {
    switch (event.type) {
      case 'document_indexed':
      case 'document_enabled':
      case 'document_removed':
        publishProjectDocumentsChanged(event.document.projectId)
        break
      case 'project_documents_removed':
        publishProjectDocumentsChanged(event.projectId)
        break
      default:
        break
    }
  })
  releaseDocumentProjection = release
  return () => {
    if (releaseDocumentProjection !== release) return
    releaseDocumentProjection = null
    release()
  }
}

export function setupRagIPC(): () => void {
  const releaseProjection = observeDocumentProjection()
  // --- Knowledge base (documents) ------------------------------------------
  ipcMain.handle('projects:list-documents', async (_e, projectId: string) => {
    requireApplicationOutcome(await desktopRag.loadProjectDocuments(projectId))
    return desktopRag.snapshot().documents.filter((document) => document.projectId === projectId)
  })

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
            const progress: ProjectIndexProgressContract = { projectId, name, stage }
            e.sender.send(PROJECT_INDEX_PROGRESS_CHANNEL, progress)
          }
        )
        requireApplicationOutcome(indexed)
        added++
      } catch (err) {
        const failed: ProjectIndexProgressContract = {
          projectId,
          name,
          stage: 'error',
          error: err instanceof Error ? err.message : String(err)
        }
        e.sender.send(PROJECT_INDEX_PROGRESS_CHANNEL, failed)
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

  return () => {
    releaseProjection()
    ipcMain.removeHandler('projects:list-documents')
    ipcMain.removeHandler('projects:add-documents')
    ipcMain.removeHandler('projects:toggle-document')
    ipcMain.removeHandler('projects:delete-document')
  }
}
