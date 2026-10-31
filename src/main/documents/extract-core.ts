// File → pages, the way AnythingLLM's collector does it: pdf.js page by page for PDFs (Mozilla's
// pdfjs-dist 4.8, the copy the app already ships), mammoth for Word, plain read for text. Runs in
// the extraction worker, and in-process when there is no built worker (running from source).

import fs from 'node:fs'
import { textParts, type DocumentPage } from '@offgrid/rag/documents'

/** Pages are sent to the host in groups of this size as they are read. */
const PAGE_BATCH = 50

export class ExtractionError extends Error {
  constructor(
    readonly code: 'password' | 'damaged' | 'unsupported',
    message: string
  ) {
    super(message)
    this.name = 'ExtractionError'
  }
}

type PdfTextItem = { str?: string; transform?: number[]; hasEOL?: boolean }

/** Lines in reading order: a new line wherever the baseline moves (pdf-parse's rule). */
function pageText(items: PdfTextItem[]): string {
  let text = ''
  let lastY: number | undefined
  for (const item of items) {
    if (typeof item.str !== 'string') continue
    const y = item.transform?.[5]
    if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 0.5) text += '\n'
    text += item.str
    if (item.hasEOL) text += '\n'
    lastY = y
  }
  return text.replace(/\n{3,}/g, '\n\n')
}

async function extractPdfPages(
  filePath: string,
  onPages: (pages: DocumentPage[]) => void,
  signal?: AbortSignal
): Promise<number> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist')
  const data = new Uint8Array(await fs.promises.readFile(filePath))
  let document: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>
  try {
    document = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0
    }).promise
  } catch (error) {
    const name = (error as { name?: string }).name
    if (name === 'PasswordException')
      throw new ExtractionError('password', 'This PDF is password-protected.')
    throw new ExtractionError('damaged', 'This PDF is damaged and could not be read.')
  }
  try {
    let batch: DocumentPage[] = []
    for (let page = 1; page <= document.numPages; page++) {
      if (signal?.aborted) break
      let text = ''
      try {
        const pdfPage = await document.getPage(page)
        const content = await pdfPage.getTextContent()
        text = pageText(content.items as PdfTextItem[])
        pdfPage.cleanup()
      } catch {
        // One unreadable page does not lose the document; it is marked for OCR by the ingest.
      }
      batch.push({ page, text })
      if (batch.length >= PAGE_BATCH) {
        onPages(batch)
        batch = []
      }
    }
    if (batch.length) onPages(batch)
    return document.numPages
  } finally {
    await document.destroy()
  }
}

async function readTextFile(filePath: string): Promise<string> {
  const bytes = await fs.promises.readFile(filePath)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '')
}

async function extractDocxText(filePath: string): Promise<string> {
  const { default: mammoth } = await import('mammoth')
  try {
    return (await mammoth.extractRawText({ path: filePath })).value
  } catch {
    throw new ExtractionError('damaged', 'This Word file is damaged and could not be read.')
  }
}

export interface ExtractRequest {
  kind: string
  path?: string
  text?: string
}

/** Every page of a document, streamed in batches. Resolves with the page count. */
export async function extractDocument(
  request: ExtractRequest,
  onPages: (pages: DocumentPage[]) => void,
  signal?: AbortSignal
): Promise<number> {
  if (request.kind === 'pdf' && request.path) return extractPdfPages(request.path, onPages, signal)
  let text = request.text
  if (text === undefined && request.path) {
    text =
      request.kind === 'docx'
        ? await extractDocxText(request.path)
        : await readTextFile(request.path)
  }
  const parts = textParts(text ?? '')
  for (let i = 0; i < parts.length; i += PAGE_BATCH) onPages(parts.slice(i, i + PAGE_BATCH))
  return parts.length
}
