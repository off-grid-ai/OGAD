// Turn a file (a chat attachment or a knowledge-base file) into a document the chat can use.
// PDF, Word and text files are kept by content hash and read page by page by the document engine
// (documents/*); images are captioned by the vision model, audio is transcribed, and video is
// sampled (~1 frame/sec) with each frame captioned, and that text is indexed the same way.
// Everything runs locally. The text returned here is only a preview for the saved message.

import path from 'path'
import os from 'os'
import fs from 'fs'
import { app } from 'electron'
import { mediaText } from './media-text'
import {
  IMAGE_EXT,
  AUDIO_EXT,
  VIDEO_EXT,
  sanitizeUploadName,
  isBinaryUploadName
} from './files-classify'
// sharp is NOT imported here. It is a native module, and a top-level import let a
// module that only validates images refuse every attachment of every type when it
// could not load — which is exactly what happened on Windows. See files-image-probe.
import { verifyImageDecodable } from './files-image-probe'

export interface ProcessedFile {
  name: string
  kind: 'text' | 'pdf' | 'docx' | 'image' | 'audio' | 'video'
  text: string
  path?: string // for images: a persisted copy so it can be sent to the vision model
  /** SHA-256 of the document's content: its identity in the conversation's document index. */
  documentId?: string
  /** Pages read so far (PDFs), when reading finished before this returned. */
  pages?: number
}

export interface ProcessUploadOptions {
  /** Chat attachments need a durable preview path. Ephemeral task guidance does not. */
  persistPreview?: boolean
  /** Task guidance needs useful image context without retaining the source image. */
  captionImage?: boolean
}

/** The saved message keeps at most this much text: enough for another device to read. */
const PREVIEW_CHARS = 200_000
/** How long an upload waits for reading to finish, to give the message a preview. */
const PREVIEW_WAIT_MS = 1_500

/** A format we cannot read: a known binary extension, or (unknown extension) NUL bytes. */
async function isUnsupportedUpload(name: string, filePath: string): Promise<boolean> {
  if (isBinaryUploadName(name)) return true
  const ext = path.extname(name).slice(1).toLowerCase()
  if ([...IMAGE_EXT, ...AUDIO_EXT, ...VIDEO_EXT, 'pdf', 'docx'].includes(ext)) return false
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const head = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const sample = head.subarray(0, bytesRead)
    // UTF-16 text has NUL bytes too; its byte-order mark says it is text.
    if ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff))
      return false
    return sample.includes(0)
  } finally {
    await handle.close()
  }
}

function uploadsDir(): string {
  return path.join(app.getPath('userData'), 'uploads')
}

/** Keep one copy per content: the same file attached twice is the same document. */
async function persistDocument(
  source: string,
  documentId: string,
  safeName: string
): Promise<string> {
  const dir = uploadsDir()
  await fs.promises.mkdir(dir, { recursive: true })
  const dest = path.join(dir, `${documentId.slice(0, 16)}-${safeName}`)
  if (!fs.existsSync(dest)) await fs.promises.copyFile(source, dest)
  return dest
}

/** Start indexing and wait briefly for the pages, to return a preview for the saved message. */
async function ingestDocument(
  name: string,
  kind: 'pdf' | 'docx' | 'text',
  filePath: string,
  documentId: string
): Promise<ProcessedFile> {
  const { documentIngest, documentStore } = await import('./documents')
  const job = documentIngest.ingest({ id: documentId, name, kind, path: filePath })
  const deadline = Date.now() + PREVIEW_WAIT_MS
  let pages = await documentStore.readPages(documentId)
  while (!pages.length && Date.now() < deadline && documentIngest.isRunning(documentId)) {
    await Promise.race([job, new Promise((resolve) => setTimeout(resolve, 150))])
    pages = await documentStore.readPages(documentId)
  }
  let preview = ''
  for (const page of pages) {
    if (preview.length >= PREVIEW_CHARS) break
    if (page.text.trim()) preview += `${preview ? '\n\n' : ''}${page.text.trim()}`
  }
  return {
    name,
    kind,
    text: preview.slice(0, PREVIEW_CHARS),
    path: filePath,
    documentId,
    ...(pages.length ? { pages: pages.length } : {})
  }
}

/** A transcript (audio, video) or an image caption is a document too: indexed from its text. */
export async function ingestTextDocument(
  name: string,
  kind: 'audio' | 'video' | 'image',
  text: string
): Promise<ProcessedFile> {
  if (!text.trim()) return { name, kind, text }
  const { hashText } = await import('./documents/conversation-documents')
  const { startDocumentIngest } = await import('./documents')
  const documentId = hashText(text)
  startDocumentIngest({ id: documentId, name, kind, text })
  return { name, kind, text: text.slice(0, PREVIEW_CHARS), documentId }
}

/** Read a file the user picked or dropped, from where it is (no copy through the renderer). */
export async function processUploadPath(
  filePath: string,
  name: string,
  options: ProcessUploadOptions = {}
): Promise<ProcessedFile> {
  const resolved = path.resolve(filePath)
  const stat = await fs.promises.stat(resolved)
  if (!stat.isFile()) throw new Error('Only files can be attached.')
  return processFileAt(resolved, name, options)
}

export async function processUpload(
  name: string,
  bytes: ArrayBuffer | Uint8Array,
  options: ProcessUploadOptions = {}
): Promise<ProcessedFile> {
  const safe = sanitizeUploadName(name)
  const tmp = path.join(os.tmpdir(), `offgrid-upload-${Date.now()}-${safe}`)
  await fs.promises.writeFile(tmp, Buffer.from(bytes as ArrayBuffer))
  try {
    return await processFileAt(tmp, name, options)
  } finally {
    fs.promises.unlink(tmp).catch(() => {})
  }
}

async function processFileAt(
  tmp: string,
  name: string,
  options: ProcessUploadOptions
): Promise<ProcessedFile> {
  const ext = path.extname(name).slice(1).toLowerCase()
  const safe = sanitizeUploadName(name)
  if (await isUnsupportedUpload(name, tmp)) {
    throw new Error(`Can't read .${ext || 'binary'} files yet. Attach a PDF, Word or text file.`)
  }
  if (IMAGE_EXT.includes(ext)) {
    // An image extension is not evidence that the bytes are decodable. Validate at
    // the upload owner before persisting or marking the attachment ready, so a
    // damaged image produces a specific recoverable error in the composer instead
    // of reaching the vision runtime as engine garbage.
    //
    // Only a READ verdict refuses the file. If the validator itself is unavailable
    // the upload proceeds unchecked: a native module that will not load is our
    // fault, not a statement about the user's photo.
    if ((await verifyImageDecodable(tmp)) === 'undecodable') {
      throw new Error('Unsupported or damaged image data.')
    }
    if (options.captionImage) {
      return { name, kind: 'image', text: await mediaText.captionImage(tmp) }
    }
    if (options.persistPreview === false) {
      return { name, kind: 'image', text: '' }
    }
    // Persist the image so the chat can pass the ACTUAL image to the multimodal
    // model. Return as soon as it's saved — do NOT block the attachment on a
    // vision-model caption (that ran the model synchronously and left the chip
    // stuck on "Reading…"). The image goes straight to the vision model anyway.
    const dir = uploadsDir()
    await fs.promises.mkdir(dir, { recursive: true })
    const dest = path.join(dir, `${Date.now()}-${safe}`)
    await fs.promises.copyFile(tmp, dest)
    return { name, kind: 'image', text: '', path: dest }
  }
  if (AUDIO_EXT.includes(ext)) {
    const text = await mediaText.transcribeAudio(tmp)
    if (options.persistPreview === false) return { name, kind: 'audio', text }
    // Kept like an image, so the recording can be played from the chat and not only read: with
    // only its transcript, opening it showed text and no player.
    const dir = uploadsDir()
    await fs.promises.mkdir(dir, { recursive: true })
    const dest = path.join(dir, `${Date.now()}-${safe}`)
    await fs.promises.copyFile(tmp, dest)
    return { ...(await ingestTextDocument(name, 'audio', text)), path: dest }
  }
  if (VIDEO_EXT.includes(ext)) {
    // ~1 frame/second, capped so a long clip doesn't run the vision model forever.
    const frames = await mediaText.sampleVideoFrames(tmp, { everySeconds: 1, maxFrames: 12 })
    const caps: string[] = []
    for (let i = 0; i < frames.length; i++) {
      try {
        caps.push(`[~${i + 1}s] ${await mediaText.captionImage(frames[i]!)}`)
      } catch {
        /* skip a bad frame */
      }
    }
    const text = caps.join('\n')
    return options.persistPreview === false
      ? { name, kind: 'video', text }
      : ingestTextDocument(name, 'video', text)
  }
  const kind: 'pdf' | 'docx' | 'text' = ext === 'pdf' ? 'pdf' : ext === 'docx' ? 'docx' : 'text'
  if (options.persistPreview === false) {
    // Ephemeral (task guidance): the text itself is the result; nothing is kept or indexed. Read by
    // the document engine's extractor, stopping once there is enough text.
    let text = ''
    try {
      const { documentExtractor } = await import('./documents/extract')
      const enough = new AbortController()
      await documentExtractor.extract(
        { id: 'preview', name, kind, path: tmp },
        {
          signal: enough.signal,
          onPages: (pages) => {
            for (const page of pages)
              if (page.text.trim()) text += `${text ? '\n\n' : ''}${page.text.trim()}`
            if (text.length >= PREVIEW_CHARS) enough.abort()
          }
        }
      )
    } catch (e) {
      if (!text)
        console.warn('[files] extraction failed; attaching without text:', (e as Error).message)
    }
    return { name, kind, text: text.slice(0, PREVIEW_CHARS) }
  }
  // Chat attachment: keep the file by content and index it in the background. The PDF viewer opens
  // the kept copy; the document index reads every page of it, with no size cap.
  const { hashFile } = await import('./documents/conversation-documents')
  const documentId = await hashFile(tmp)
  const kept = await persistDocument(tmp, documentId, safe)
  return ingestDocument(name, kind, kept, documentId)
}
