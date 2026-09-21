// OCR a screenshot via the bundled macOS Vision binary (electron/accessibility/ocr).
// The legacy text API remains stable. The boxed API owns structured OCR.

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
        path.join(process.cwd(), 'resources', 'bin', 'ocr'),
        path.join(app.getAppPath(), 'resources', 'bin', 'ocr'),
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

export interface OcrBlock {
  text: string
  confidence: number
  bounds: { x: number; y: number; width: number; height: number }
}

export interface BoxedOcrResult {
  width: number
  height: number
  blocks: OcrBlock[]
  available: boolean
  degradedReason?: string
}

export async function runBoxedOCR(imagePath: string): Promise<BoxedOcrResult> {
  const bin = ocrBin()
  if (!bin) {
    return {
      width: 0,
      height: 0,
      blocks: [],
      available: false,
      degradedReason: 'ocr_helper_missing'
    }
  }
  try {
    const { stdout } = await execFileAsync(bin, ['--json', imagePath], {
      maxBuffer: 32 * 1024 * 1024
    })
    const value = JSON.parse(stdout) as { width?: unknown; height?: unknown; blocks?: unknown }
    const blocks = Array.isArray(value.blocks)
      ? value.blocks.filter((block): block is OcrBlock => {
          if (!block || typeof block !== 'object') return false
          const candidate = block as Partial<OcrBlock>
          return (
            typeof candidate.text === 'string' &&
            typeof candidate.confidence === 'number' &&
            typeof candidate.bounds?.x === 'number' &&
            typeof candidate.bounds.y === 'number' &&
            typeof candidate.bounds.width === 'number' &&
            typeof candidate.bounds.height === 'number'
          )
        })
      : []
    return {
      width: typeof value.width === 'number' ? value.width : 0,
      height: typeof value.height === 'number' ? value.height : 0,
      blocks,
      available: true
    }
  } catch (error) {
    console.error('[OCR] boxed OCR failed:', error)
    return { width: 0, height: 0, blocks: [], available: false, degradedReason: 'ocr_failed' }
  }
}

export async function runOCR(imagePath: string): Promise<string> {
  const bin = ocrBin()
  if (!bin) return ''
  try {
    const { stdout } = await execFileAsync(bin, [imagePath], { maxBuffer: 32 * 1024 * 1024 })
    return stdout.trim()
  } catch (e) {
    console.error('[OCR] failed:', e)
    return ''
  }
}
