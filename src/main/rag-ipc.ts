// IPC surface for projects + RAG (knowledge bases) + project chat. Kept separate
// from the large ipc.ts. Registered from main/index.ts via setupRagIPC().

import { reportDocumentAdded, track } from './analytics'
import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'node:crypto'
import { knowledgeBase, listProjects, createProject, updateProject, deleteProject } from './rag'
import { uploadPickerExtensions } from './files-classify'
import { projectDeleteFailure, type ProjectDeleteOutcome } from '../shared/project-delete-outcome'
import {
  PROJECT_DOCUMENT_TRANSFER_DISMISS,
  PROJECT_DOCUMENT_TRANSFERS_SNAPSHOT
} from '../shared/project-document-transfer'
import {
  dismissProjectDocumentTransfer,
  projectDocumentTransfers
} from './project-document-transfers'

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
      track('project_created')
      return id
    }
  )

  ipcMain.handle('projects:update', (_e, id: string, patch: Record<string, unknown>) => {
    updateProject(id, patch)
  })

  ipcMain.handle('projects:delete', (_e, id: string): ProjectDeleteOutcome => {
    try {
      // The RAG store owns one transaction for the project, its documents, and its chat links.
      // Report that transaction's result before the renderer drops its local projection.
      deleteProject(id)
      track('item_deleted', { item: 'project' })
      return { ok: true }
    } catch (error) {
      return projectDeleteFailure(error)
    }
  })

  // --- Knowledge base (documents) ------------------------------------------
  // Each file with how far the document engine has read and indexed it. A file that is not
  // indexed yet (added before files had document ids, or cut off by a restart) starts now, so
  // the list never shows a file as ready that a question could not use.
  ipcMain.handle('projects:list-documents', async (e, projectId: string) => {
    const { documentStore, startDocumentIngest } = await import('./documents')
    return Promise.all(
      knowledgeBase.listDocuments(projectId).map(async (document) => {
        if (!document.documentId) {
          void knowledgeBase.documentIdFor(document, true).then((id) => {
            if (id && !e.sender.isDestroyed())
              e.sender.send('projects:documents-changed', { projectId })
          })
        }
        const indexed = document.documentId
          ? await documentStore.getDocument(document.documentId)
          : null
        if (
          document.documentId &&
          document.enabled &&
          (!indexed || indexed.state === 'reading' || indexed.state === 'indexing') &&
          fs.existsSync(document.path)
        ) {
          startDocumentIngest({
            id: document.documentId,
            name: document.name,
            kind: document.kind,
            path: document.path
          })
        }
        return {
          ...document,
          ...(indexed
            ? {
                state: indexed.state,
                pageCount: indexed.pageCount,
                chunkCount: indexed.chunkCount,
                embeddedCount: indexed.embeddedCount,
                ...(indexed.error ? { error: indexed.error } : {})
              }
            : {})
        }
      })
    )
  })

  ipcMain.handle('projects:add-documents', async (e, projectId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Add to knowledge base',
      properties: ['openFile', 'multiSelections'],
      filters: DOC_FILTERS
    })
    if (result.canceled || result.filePaths.length === 0) return { added: 0 }

    // Each file shows as "Adding…" until it is kept and its reading has started; from then on its
    // row follows the document engine's progress (documents:progress).
    let added = 0
    for (const filePath of result.filePaths) {
      const name = path.basename(filePath)
      let size = 0
      try {
        size = fs.statSync(filePath).size
      } catch {
        /* ignore */
      }
      e.sender.send('projects:index-progress', { projectId, name, stage: 'adding' })
      try {
        await knowledgeBase.addFile({ projectId, path: filePath, fileName: name, size })
        reportDocumentAdded(name, size)
        added++
        e.sender.send('projects:index-progress', { projectId, name, stage: 'done' })
        e.sender.send('projects:documents-changed', { projectId })
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

  // Files moving to or from a paired device. Sync registers the source; without it the list is empty.
  ipcMain.handle(PROJECT_DOCUMENT_TRANSFERS_SNAPSHOT, (_e, projectId: string) =>
    projectDocumentTransfers(projectId)
  )
  ipcMain.handle(PROJECT_DOCUMENT_TRANSFER_DISMISS, (_e, key: string) =>
    dismissProjectDocumentTransfer(key)
  )

  ipcMain.handle('projects:toggle-document', (_e, docId: number, enabled: boolean) =>
    knowledgeBase.toggleDocument(docId, enabled)
  )

  ipcMain.handle('projects:delete-document', (_e, docId: number) => {
    const deleted = knowledgeBase.deleteDocument(docId)
    track('item_deleted', { item: 'document' })
    return deleted
  })
}
