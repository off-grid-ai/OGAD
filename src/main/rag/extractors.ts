// Desktop ExtractionBridges for @offgrid/rag. Turns a file into plain text:
//   text/code -> fs.readFile
//   pdf        -> pdf-parse
//   docx       -> mammoth
//   audio      -> ffmpeg (to 16k mono WAV) -> bundled whisper-cli
//   video      -> ffmpeg (sample frames) -> vision model caption per frame
//   image      -> vision model caption
// whisper-cli is bundled in resources/bin/whisper; ffmpeg is resolved from a
// bundled path first, then the system. Vision captioning reuses llm.chat.

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import type { ExtractionBridges } from '@offgrid/rag';
import { llm } from '../llm';
import { getActiveModal } from '../active-models';

const execFileAsync = promisify(execFile);

function existing(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Resolve the bundled whisper-cli across dev / packaged layouts. */
export function whisperBin(): string | null {
  return existing([
    path.join(process.resourcesPath ?? '', 'bin', 'whisper', 'whisper-cli'),
    path.join(app.getAppPath(), 'resources', 'bin', 'whisper', 'whisper-cli'),
    path.join(process.cwd(), 'resources', 'bin', 'whisper', 'whisper-cli'),
  ]);
}

/** Resolve ffmpeg: bundled first, then common system locations. */
function ffmpegBin(): string | null {
  return existing([
    path.join(process.resourcesPath ?? '', 'bin', 'ffmpeg'),
    path.join(app.getAppPath(), 'resources', 'bin', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]);
}

/** Find a downloaded whisper ggml model in the user's models dir. Prefers a
 *  MULTILINGUAL model (the `.en` models can only do English) and a more capable
 *  size for accuracy, since meetings may be in any language. */
export function whisperModel(): string | null {
  const dir = path.join(app.getPath('userData'), 'models');
  try {
    // User-chosen transcription model wins, when it's actually present on disk.
    const chosen = getActiveModal('transcription');
    if (chosen && fs.existsSync(path.join(dir, chosen))) return path.join(dir, chosen);
    const files = fs.readdirSync(dir).filter((f) => /^ggml-.*\.bin$/i.test(f));
    if (!files.length) return null;
    // Multilingual = NOT an `.en` model.
    const multi = files.filter((f) => !/\.en\.bin$/i.test(f));
    const pool = multi.length ? multi : files; // fall back to whatever exists
    // Prefer larger/more-accurate multilingual models for non-English speech.
    const rank = (f: string): number =>
      /large/i.test(f) ? 4 : /medium/i.test(f) ? 3 : /small/i.test(f) ? 2 : /base/i.test(f) ? 1 : 0;
    const pick = [...pool].sort((a, b) => rank(b) - rank(a))[0];
    return path.join(dir, pick);
  } catch {
    return null;
  }
}

const IMAGE_PROMPT =
  'Describe this image in detail and transcribe any visible text verbatim. Be thorough; this will be indexed for search.';

export const desktopExtraction: ExtractionBridges = {
  async readText(p) {
    return fs.promises.readFile(p, 'utf8');
  },

  async extractPdf(p, maxChars) {
    // pdf-parse is CJS with a debug side-effect on import; require lazily.
    const pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{ text: string }>;
    const buf = await fs.promises.readFile(p);
    const { text } = await pdfParse(buf);
    return maxChars ? text.slice(0, maxChars) : text;
  },

  async extractDocx(p, maxChars) {
    const mammoth = require('mammoth') as { extractRawText(o: { path: string }): Promise<{ value: string }> };
    const { value } = await mammoth.extractRawText({ path: p });
    return maxChars ? value.slice(0, maxChars) : value;
  },

  async transcribeAudio(p) {
    const bin = whisperBin();
    if (!bin) throw new Error('Transcription runtime (whisper) is not installed.');
    const model = whisperModel();
    if (!model) throw new Error('No transcription model found — download Whisper from Models first.');
    const ff = ffmpegBin();
    if (!ff) throw new Error('ffmpeg is required to decode audio and was not found.');

    const tmp = path.join(os.tmpdir(), `offgrid-stt-${Date.now()}.wav`);
    try {
      // Whisper needs 16 kHz mono PCM WAV.
      await execFileAsync(ff, ['-y', '-i', p, '-ar', '16000', '-ac', '1', '-f', 'wav', tmp]);
      const { stdout } = await execFileAsync(
        bin,
        // -l auto: detect the spoken language (whisper.cpp defaults to English).
        // -mc 0 + -sns: kill the repetition/hallucination loop (the model feeding
        // its own repeated output back) and suppress non-speech tokens.
        ['-m', model, '-f', tmp, '-l', 'auto', '-mc', '0', '-sns', '-nt', '-np'],
        { maxBuffer: 64 * 1024 * 1024 }
      );
      return stdout.trim();
    } finally {
      fs.promises.unlink(tmp).catch(() => {});
    }
  },

  async sampleVideoFrames(p, opts) {
    const ff = ffmpegBin();
    if (!ff) throw new Error('ffmpeg is required to sample video frames and was not found.');
    const every = Math.max(1, opts.everySeconds ?? 5);
    const maxFrames = Math.max(1, opts.maxFrames ?? 24);
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'offgrid-frames-'));
    // One frame every `every` seconds, capped at maxFrames.
    await execFileAsync(ff, [
      '-y',
      '-i',
      p,
      '-vf',
      `fps=1/${every},scale=768:-1`,
      '-frames:v',
      String(maxFrames),
      path.join(dir, 'frame_%03d.jpg'),
    ]);
    const frames = (await fs.promises.readdir(dir))
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .map((f) => path.join(dir, f));
    return frames;
  },

  async captionImage(imagePath) {
    // Reuse the local vision model. Requires an active vision (mmproj) model.
    return (await llm.chat(IMAGE_PROMPT, [imagePath], 300000, 1024)).trim();
  },
};
