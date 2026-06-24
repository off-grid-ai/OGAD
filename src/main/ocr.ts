// OCR a screenshot via the bundled macOS Vision binary (electron/accessibility/ocr).
// Returns the recognized text (newline-joined), or '' on any failure.

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

const execFileAsync = promisify(execFile);

function ocrBin(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'ocr'), path.join(process.resourcesPath, 'bin', 'ocr')]
    : [
        path.join(process.cwd(), 'electron', 'accessibility', 'ocr'),
        path.join(app.getAppPath(), 'electron', 'accessibility', 'ocr'),
      ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function runOCR(imagePath: string): Promise<string> {
  const bin = ocrBin();
  if (!bin) return '';
  try {
    const { stdout } = await execFileAsync(bin, [imagePath], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    console.error('[OCR] failed:', e);
    return '';
  }
}
