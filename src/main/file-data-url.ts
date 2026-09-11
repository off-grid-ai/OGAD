import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { mimeForExt } from './mime'

export async function uploadedFileDataUrl(candidate?: string): Promise<string | null> {
  try {
    const root = path.resolve(app.getPath('userData'), 'uploads')
    const resolved = path.resolve(candidate ?? '')
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null
    const bytes = await fs.promises.readFile(resolved)
    const extension = (resolved.split('.').pop() || '').toLowerCase()
    return `data:${mimeForExt(extension, 'application/octet-stream')};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}
