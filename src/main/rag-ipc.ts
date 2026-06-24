// IPC surface for projects + RAG (knowledge bases) + project chat. Kept separate
// from the large ipc.ts. Registered from main/index.ts via setupRagIPC().

import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'fs';
import {
  ragService,
  projectChat,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  listThreads,
  createThread,
  renameThread,
  deleteThread,
  getThreadMessages,
} from './rag';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const DOC_FILTERS = [
  {
    name: 'Documents, audio & video',
    extensions: [
      'txt', 'md', 'markdown', 'csv', 'json', 'pdf', 'docx',
      'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg',
      'mp4', 'mov', 'mkv', 'webm', 'm4v',
      'png', 'jpg', 'jpeg', 'webp',
    ],
  },
];

export function setupRagIPC(): void {
  // --- Projects -------------------------------------------------------------
  ipcMain.handle('projects:list', () => listProjects());

  ipcMain.handle('projects:create', (_e, p: { name: string; description?: string; systemPrompt?: string; icon?: string }) => {
    const id = genId('proj');
    createProject({ id, ...p });
    return id;
  });

  ipcMain.handle('projects:update', (_e, id: string, patch: Record<string, unknown>) => {
    updateProject(id, patch);
  });

  ipcMain.handle('projects:delete', (_e, id: string) => deleteProject(id));

  // --- Knowledge base (documents) ------------------------------------------
  ipcMain.handle('projects:list-documents', (_e, projectId: string) => ragService.listDocuments(projectId));

  ipcMain.handle('projects:add-documents', async (e, projectId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win!, {
      title: 'Add to knowledge base',
      properties: ['openFile', 'multiSelections'],
      filters: DOC_FILTERS,
    });
    if (result.canceled || result.filePaths.length === 0) return { added: 0 };

    let added = 0;
    for (const filePath of result.filePaths) {
      const name = filePath.split('/').pop() ?? filePath;
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch {
        /* ignore */
      }
      try {
        await ragService.indexDocument({ projectId, path: filePath, fileName: name, size }, (stage) => {
          e.sender.send('projects:index-progress', { projectId, name, stage });
        });
        added++;
      } catch (err) {
        e.sender.send('projects:index-progress', {
          projectId,
          name,
          stage: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { added };
  });

  ipcMain.handle('projects:toggle-document', (_e, docId: number, enabled: boolean) =>
    ragService.toggleDocument(docId, enabled)
  );

  ipcMain.handle('projects:delete-document', (_e, docId: number) => ragService.deleteDocument(docId));

  // --- Threads + chat -------------------------------------------------------
  ipcMain.handle('projects:list-threads', (_e, projectId: string) => listThreads(projectId));

  ipcMain.handle('projects:create-thread', (_e, projectId: string, title?: string) => {
    const id = genId('thr');
    createThread(id, projectId, title);
    return id;
  });

  ipcMain.handle('projects:rename-thread', (_e, id: string, title: string) => renameThread(id, title));
  ipcMain.handle('projects:delete-thread', (_e, id: string) => deleteThread(id));
  ipcMain.handle('projects:thread-messages', (_e, threadId: string) => getThreadMessages(threadId));

  ipcMain.handle('projects:chat', (_e, params: { projectId: string; threadId: string; message: string }) =>
    projectChat(params)
  );
}
