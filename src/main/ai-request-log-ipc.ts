import { app, BrowserWindow, ipcMain } from 'electron'
import { preloadPath } from './preload-path'
import { rendererHtmlPath } from './renderer-path'
import {
  listAIRequestLogs,
  getAIRequestLog,
  relatedAIRequests,
  clearAIRequestLogs,
  readAIRequestAttachment
} from './ai-request-log-store'
import { modelDisplayName } from '@offgrid/models'
import {
  AI_MODALITIES,
  type AILogPage,
  type AILogQuery,
  type AIRequestSummary
} from '../shared/ai-request-log'

/** Turns a logged model reference (an id, a file name or a path) into the name a person reads. */
export type AILogModelNamer = (ref: string) => string

const sharedNamer: AILogModelNamer = (ref) => modelDisplayName(ref) ?? ref

/** Logs record what the runtime ran: often a file path. The screen shows the model's name. */
export function nameLoggedModels<T extends AIRequestSummary>(row: T, name: AILogModelNamer): T {
  return row.model ? { ...row, model: name(row.model) } : row
}

let activityWindow: BrowserWindow | null = null

export function validateAILogQuery(value: unknown): AILogQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const q = value as Record<string, unknown>
  const result: AILogQuery = {}
  if (typeof q.search === 'string') result.search = q.search.slice(0, 300)
  if (AI_MODALITIES.includes(q.modality as never))
    result.modality = q.modality as AILogQuery['modality']
  if (['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(String(q.status)))
    result.status = q.status as AILogQuery['status']
  if (['gpu', 'cpu', 'unknown'].includes(String(q.hardware)))
    result.hardware = q.hardware as AILogQuery['hardware']
  if (['newest', 'oldest', 'slowest'].includes(String(q.sort)))
    result.sort = q.sort as AILogQuery['sort']
  for (const key of ['since', 'minDurationMs', 'offset', 'limit'] as const) {
    if (typeof q[key] === 'number' && Number.isFinite(q[key]))
      result[key] = Math.max(0, q[key] as number)
  }
  return result
}

export async function openAIActivityWindow(): Promise<void> {
  if (activityWindow && !activityWindow.isDestroyed()) {
    if (activityWindow.isMinimized()) activityWindow.restore()
    activityWindow.show()
    activityWindow.focus()
    return
  }
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 620,
    minHeight: 480,
    title: 'AI activity - Off Grid AI Desktop',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  activityWindow = window
  window.on('closed', () => {
    if (activityWindow === window) activityWindow = null
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  try {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      const url = new URL(process.env.ELECTRON_RENDERER_URL)
      url.hash = 'ai-activity'
      await window.loadURL(url.toString())
    } else await window.loadFile(rendererHtmlPath(), { hash: 'ai-activity' })
    if (!window.isDestroyed()) window.show()
  } catch (error) {
    window.destroy()
    throw error
  }
}

export function setupAIRequestLogIPC(nameModel: AILogModelNamer = sharedNamer): void {
  ipcMain.handle('ai-logs:list', (_event, query: unknown) => {
    const page: AILogPage = listAIRequestLogs(validateAILogQuery(query))
    return Array.isArray(page.rows)
      ? { ...page, rows: page.rows.map((row) => nameLoggedModels(row, nameModel)) }
      : page
  })
  ipcMain.handle('ai-logs:detail', (_event, id: unknown) => {
    const record = typeof id === 'string' ? getAIRequestLog(id) : null
    return record ? nameLoggedModels(record, nameModel) : null
  })
  ipcMain.handle('ai-logs:related', (_event, id: unknown) =>
    typeof id === 'string'
      ? relatedAIRequests(id).map((row) => nameLoggedModels(row, nameModel))
      : []
  )
  ipcMain.handle('ai-logs:attachment', (_event, id: unknown, asset: unknown) =>
    typeof id === 'string' && typeof asset === 'string' ? readAIRequestAttachment(id, asset) : null
  )
  ipcMain.handle('ai-logs:clear', () => clearAIRequestLogs())
  ipcMain.handle('ai-logs:open-window', () => openAIActivityWindow())
}
