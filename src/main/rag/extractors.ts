// Desktop ExtractionBridges for @offgrid/rag. Turns a file into plain text:
//   text/code -> fs.readFile
//   pdf        -> pdf-parse
//   docx       -> mammoth
//   audio      -> ffmpeg (to 16k mono WAV) -> bundled whisper-cli
//   video      -> ffmpeg (sample frames) -> vision model caption per frame
//   image      -> vision model caption
// whisper-cli is bundled in resources/bin/whisper; ffmpeg is resolved from a
// bundled path first, then the system. Vision captioning reuses llm.chat.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ExtractionBridges } from '@offgrid/rag'
import { generateDesktopText } from '../desktop-generation'
import { ffmpegBin } from '../transcription/whisper-cli'
import { getActiveTranscription } from '../transcription/select'

const execFileAsync = promisify(execFile)
const loadCjsDependency = createRequire(import.meta.url)

// Binary/model resolvers now live in ../transcription/whisper-cli (single source
// of truth). Re-exported here so existing importers of '@offgrid/core/main/rag/
// extractors' keep working.
export { whisperModel } from '../transcription/whisper-cli'

const IMAGE_PROMPT =
  'Describe this image in detail and transcribe any visible text verbatim. Be thorough; this will be indexed for search.'

export const desktopExtraction: ExtractionBridges = {
  async readText(p) {
    return fs.promises.readFile(p, 'utf8')
  },

  async extractPdf(p, maxChars) {
    // pdf-parse has a debug side-effect on import, so load it only when needed.
    const pdfParse = loadCjsDependency('pdf-parse') as (
      bytes: Uint8Array
    ) => Promise<{ text: string }>
    const buf = await fs.promises.readFile(p)
    // Pass owned plain bytes: pdf-parse can reject valid PDFs when given a Node Buffer directly.
    const { text } = await pdfParse(new Uint8Array(buf))
    return maxChars ? text.slice(0, maxChars) : text
  },

  async extractDocx(p, maxChars) {
    const { default: mammoth } = await import('mammoth')
    const { value } = await mammoth.extractRawText({ path: p })
    return maxChars ? value.slice(0, maxChars) : value
  },

  async transcribeAudio(p) {
    // Delegates to the active TranscriptionService (whisper by default, Parakeet when
    // the user selected a Parakeet model and its runtime is installed). Kept on the
    // ExtractionBridges surface for rag/file-ingest callers.
    return (await getActiveTranscription().transcribe({ path: p })).text
  },

  async sampleVideoFrames(p, opts) {
    const ff = ffmpegBin()
    if (!ff) throw new Error('ffmpeg is required to sample video frames and was not found.')
    const every = Math.max(1, opts.everySeconds ?? 5)
    const maxFrames = Math.max(1, opts.maxFrames ?? 24)
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'offgrid-frames-'))
    // One frame every `every` seconds, capped at maxFrames.
    await execFileAsync(ff, [
      '-y',
      '-i',
      p,
      '-vf',
      `fps=1/${every},scale=768:-1`,
      '-frames:v',
      String(maxFrames),
      path.join(dir, 'frame_%03d.jpg')
    ])
    const frames = (await fs.promises.readdir(dir))
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .map((f) => path.join(dir, f))
    return frames
  },

  async captionImage(imagePath) {
    // Reuse the local vision model. Requires an active vision (mmproj) model.
    return (
      await generateDesktopText(IMAGE_PROMPT, {
        profile: 'vision-caption',
        operation: { type: 'vision' },
        images: [imagePath]
      })
    ).content.trim()
  }
}
