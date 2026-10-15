// OCR a screenshot via the bundled macOS Vision binary (electron/accessibility/ocr).
// The boxed API owns structured OCR; runPdfOCR reads scanned PDF pages.

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

/** The Vision helper is present (macOS builds). */
export function visionOcrAvailable(): boolean {
  return process.platform === 'darwin' && ocrBin() !== null
}

/**
 * Read scanned PDF pages with the Vision helper's PDF mode: one process per page range, pages
 * streamed back as JSON lines. Ranges run in up to `parallel` helpers at once.
 */
export async function runPdfOCR(
  pdfPath: string,
  pages: number[],
  options: {
    signal?: AbortSignal
    parallel?: number
    onPage?: (page: number, text: string) => void
  } = {}
): Promise<Map<number, string>> {
  const bin = ocrBin()
  const results = new Map<number, string>()
  if (!bin || !pages.length) return results
  const { spawn } = await import('child_process')
  const lanes = Math.max(1, Math.min(options.parallel ?? 2, pages.length))
  const groups: number[][] = Array.from({ length: lanes }, () => [])
  pages.forEach((page, i) => groups[i % lanes]!.push(page))
  await Promise.all(
    groups.map(
      (group) =>
        new Promise<void>((resolve) => {
          if (options.signal?.aborted) return resolve()
          const child = spawn(bin, ['--pdf', pdfPath, '--pages', group.join(',')], {
            stdio: ['ignore', 'pipe', 'ignore']
          })
          const stop = (): void => {
            child.kill()
          }
          options.signal?.addEventListener('abort', stop, { once: true })
          let buffered = ''
          child.stdout.setEncoding('utf8')
          child.stdout.on('data', (data: string) => {
            buffered += data
            let newline = buffered.indexOf('\n')
            while (newline >= 0) {
              const line = buffered.slice(0, newline).trim()
              buffered = buffered.slice(newline + 1)
              newline = buffered.indexOf('\n')
              if (!line) continue
              try {
                const value = JSON.parse(line) as { page?: unknown; text?: unknown }
                if (typeof value.page === 'number' && typeof value.text === 'string') {
                  results.set(value.page, value.text)
                  options.onPage?.(value.page, value.text)
                }
              } catch {
                /* a partial line from a killed helper */
              }
            }
          })
          child.on('close', () => {
            options.signal?.removeEventListener('abort', stop)
            resolve()
          })
          child.on('error', () => resolve())
        })
    )
  )
  return results
}
