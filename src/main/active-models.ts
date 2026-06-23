// Per-modality active-model selection. The text/vision chat LLM is switched via
// active-model.json (it reloads llama-server); the other modalities — image,
// speech (TTS), transcription (STT) — are stateless per-call runtimes, so we just
// record the chosen model id here and each runtime reads it (falling back to its
// own heuristic when nothing is chosen). One file: active-modalities.json.
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export type Modality = 'image' | 'speech' | 'transcription';

function storeFile(): string {
  return path.join(app.getPath('userData'), 'models', 'active-modalities.json');
}

function readAll(): Record<string, string | null> {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf-8'));
  } catch {
    return {};
  }
}

/** The chosen model id for a modality, or null to use the runtime's default. */
export function getActiveModal(kind: Modality): string | null {
  return readAll()[kind] ?? null;
}

export function setActiveModal(kind: Modality, id: string | null): void {
  const cur = readAll();
  cur[kind] = id;
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify(cur, null, 2));
  } catch (e) {
    console.error('[active-models] write failed', e);
  }
}

export function getAllActiveModals(): Record<Modality, string | null> {
  const all = readAll();
  return {
    image: all.image ?? null,
    speech: all.speech ?? null,
    transcription: all.transcription ?? null,
  };
}
