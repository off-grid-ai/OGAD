// OCR a screenshot via the bundled macOS Vision binary (electron/accessibility/ocr).
// Returns the recognized text (newline-joined), or '' on any failure.

import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

const execFileAsync = promisify(execFile)

function ocrBin(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'ocr'), path.join(process.resourcesPath, 'bin', 'ocr')]
    : [
        path.join(process.cwd(), 'electron', 'accessibility', 'ocr'),
        path.join(app.getAppPath(), 'electron', 'accessibility', 'ocr')
      ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

export type OCRResult = { ok: true; text: string } | { ok: false; message: string }

/** Callers that make decisions from OCR must distinguish an unreadable image from a failed probe. */
export async function readOCR(imagePath: string, timeoutMs?: number): Promise<OCRResult> {
  const bin = ocrBin()
  if (!bin) return { ok: false, message: 'The on-device OCR helper is unavailable' }
  try {
    const { stdout } = await execFileAsync(bin, [imagePath], {
      maxBuffer: 32 * 1024 * 1024,
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs })
    })
    return { ok: true, text: stdout.trim() }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export async function runOCR(imagePath: string): Promise<string> {
  const result = await readOCR(imagePath)
  if (result.ok) return result.text
  console.error('[OCR] failed:', result.message)
  return ''
}
