// Turn an uploaded/pasted file into text the chat can reason over. Routes by
// extension to the existing on-device extractors: plain text/code/md is read
// as-is, PDFs/DOCX are parsed, images are captioned by the vision model, audio
// is transcribed by whisper, and video is sampled (~1 frame/sec) then each frame
// captioned. Everything runs locally — nothing leaves the machine.

import path from 'path';
import os from 'os';
import fs from 'fs';
import { app } from 'electron';
import { desktopExtraction as ex } from './rag/extractors';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'aiff', 'aif'];
const VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'];

export interface ProcessedFile {
  name: string;
  kind: 'text' | 'pdf' | 'docx' | 'image' | 'audio' | 'video';
  text: string;
  path?: string; // for images: a persisted copy so it can be sent to the vision model
}

export async function processUpload(name: string, bytes: ArrayBuffer | Uint8Array): Promise<ProcessedFile> {
  const ext = path.extname(name).slice(1).toLowerCase();
  const safe = name.replace(/[^\w.-]+/g, '_');
  const tmp = path.join(os.tmpdir(), `offgrid-upload-${Date.now()}-${safe}`);
  await fs.promises.writeFile(tmp, Buffer.from(bytes as ArrayBuffer));
  try {
    if (IMAGE_EXT.includes(ext)) {
      // Persist the image so the chat can pass the ACTUAL image to the multimodal
      // model (not just a caption). Caption too, as a text fallback.
      const dir = path.join(app.getPath('userData'), 'uploads');
      await fs.promises.mkdir(dir, { recursive: true });
      const dest = path.join(dir, `${Date.now()}-${safe}`);
      await fs.promises.copyFile(tmp, dest);
      const text = ex.captionImage ? await ex.captionImage(dest).catch(() => '') : '';
      return { name, kind: 'image', text, path: dest };
    }
    if (AUDIO_EXT.includes(ext)) {
      if (!ex.transcribeAudio) throw new Error('Transcription runtime not available.');
      return { name, kind: 'audio', text: await ex.transcribeAudio(tmp) };
    }
    if (VIDEO_EXT.includes(ext)) {
      if (!ex.sampleVideoFrames) throw new Error('Video sampling not available.');
      // ~1 frame/second, capped so a long clip doesn't run the vision model forever.
      const frames = await ex.sampleVideoFrames(tmp, { everySeconds: 1, maxFrames: 12 });
      const caps: string[] = [];
      for (let i = 0; i < frames.length; i++) {
        try {
          caps.push(`[~${i + 1}s] ${ex.captionImage ? await ex.captionImage(frames[i]) : ''}`);
        } catch {
          /* skip a bad frame */
        }
      }
      return { name, kind: 'video', text: caps.join('\n') };
    }
    if (ext === 'pdf') return { name, kind: 'pdf', text: ex.extractPdf ? await ex.extractPdf(tmp, 200_000) : '' };
    if (ext === 'docx') return { name, kind: 'docx', text: ex.extractDocx ? await ex.extractDocx(tmp, 200_000) : '' };
    // Everything else is treated as text — .txt/.md and every programming
    // language file (.js/.ts/.py/.go/.rs/.json/.csv/…) is just text.
    return { name, kind: 'text', text: await ex.readText(tmp) };
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}
