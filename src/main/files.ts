// Turn an uploaded/pasted file into text the chat can reason over. Routes by
// extension to the existing on-device extractors: plain text/code/md is read
// as-is, PDFs/DOCX are parsed, images are captioned by the vision model, audio
// is transcribed by whisper, and video is sampled (~1 frame/sec) then each frame
// captioned. Everything runs locally — nothing leaves the machine.

import path from 'path'
import os from 'os'
import fs from 'fs'
import { app } from 'electron'
import { desktopExtraction as ex } from './rag/extractors'
import { IMAGE_EXT, AUDIO_EXT, VIDEO_EXT, sanitizeUploadName } from './files-classify'
// sharp is NOT imported here. It is a native module, and a top-level import let a
// module that only validates images refuse every attachment of every type when it
// could not load — which is exactly what happened on Windows. See files-image-probe.
import { verifyImageDecodable } from './files-image-probe'

export interface ProcessedFile {
  name: string
  kind: 'text' | 'pdf' | 'docx' | 'image' | 'audio' | 'video'
  text: string
  path?: string // for images: a persisted copy so it can be sent to the vision model
}

export async function processUpload(
  name: string,
  bytes: ArrayBuffer | Uint8Array
): Promise<ProcessedFile> {
  const ext = path.extname(name).slice(1).toLowerCase()
  const safe = sanitizeUploadName(name)
  const tmp = path.join(os.tmpdir(), `offgrid-upload-${Date.now()}-${safe}`)
  await fs.promises.writeFile(tmp, Buffer.from(bytes as ArrayBuffer))
  try {
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
      // Persist the image so the chat can pass the ACTUAL image to the multimodal
      // model. Return as soon as it's saved — do NOT block the attachment on a
      // vision-model caption (that ran the model synchronously and left the chip
      // stuck on "Reading…"). The image goes straight to the vision model anyway.
      const dir = path.join(app.getPath('userData'), 'uploads')
      await fs.promises.mkdir(dir, { recursive: true })
      const dest = path.join(dir, `${Date.now()}-${safe}`)
      await fs.promises.copyFile(tmp, dest)
      return { name, kind: 'image', text: '', path: dest }
    }
    if (AUDIO_EXT.includes(ext)) {
      if (!ex.transcribeAudio) throw new Error('Transcription runtime not available.')
      return { name, kind: 'audio', text: await ex.transcribeAudio(tmp) }
    }
    if (VIDEO_EXT.includes(ext)) {
      if (!ex.sampleVideoFrames) throw new Error('Video sampling not available.')
      // ~1 frame/second, capped so a long clip doesn't run the vision model forever.
      const frames = await ex.sampleVideoFrames(tmp, { everySeconds: 1, maxFrames: 12 })
      const caps: string[] = []
      for (let i = 0; i < frames.length; i++) {
        try {
          caps.push(`[~${i + 1}s] ${ex.captionImage ? await ex.captionImage(frames[i]!) : ''}`)
        } catch {
          /* skip a bad frame */
        }
      }
      return { name, kind: 'video', text: caps.join('\n') }
    }
    if (ext === 'pdf') {
      // Persist the PDF so the chat viewer can render the ACTUAL file (Chromium's
      // built-in viewer), in addition to extracting text for the model context.
      const dir = path.join(app.getPath('userData'), 'uploads')
      await fs.promises.mkdir(dir, { recursive: true })
      const dest = path.join(dir, `${Date.now()}-${safe}`)
      await fs.promises.copyFile(tmp, dest)
      // Text extraction is best-effort: the PDF is already persisted and viewable,
      // so a parse failure must NOT make the file unattachable — fall back to ''.
      let text = ''
      try {
        if (ex.extractPdf) text = await ex.extractPdf(tmp, 200_000)
      } catch (e) {
        console.warn(
          '[files] PDF text extraction failed; attaching without text:',
          (e as Error).message
        )
      }
      return { name, kind: 'pdf', text, path: dest }
    }
    if (ext === 'docx')
      return { name, kind: 'docx', text: ex.extractDocx ? await ex.extractDocx(tmp, 200_000) : '' }
    // Everything else is treated as text — .txt/.md and every programming
    // language file (.js/.ts/.py/.go/.rs/.json/.csv/…) is just text.
    return { name, kind: 'text', text: await ex.readText(tmp) }
  } finally {
    fs.promises.unlink(tmp).catch(() => {})
  }
}
