// On-device text-to-speech via Kokoro-82M (open-weight, Apache-2.0, multilingual).
//
// Kokoro runs through kokoro-js, which uses @huggingface/transformers' bundled
// onnxruntime-node. The main process ALSO loads @xenova/transformers (for
// embeddings), whose onnxruntime-node is a different build — and loading two
// native ORT runtimes in one process throws "Session already disposed". So we run
// Kokoro in a short-lived subprocess (Electron-as-Node) instead: it isolates the
// ORT runtime AND means the model is only resident while speaking, then freed —
// swap-in / swap-out rather than a permanent ~330MB resident session.

import { spawn } from 'child_process';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getActiveModal } from './active-models';

const DEFAULT_VOICE = 'af_heart';

function workerPath(): string {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'tts-worker.mjs')]
    : [
        path.join(app.getAppPath(), 'resources', 'tts-worker.mjs'),
        path.join(process.cwd(), 'resources', 'tts-worker.mjs'),
      ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('tts-worker.mjs not found in resources.');
  return found;
}

// Run the TTS worker in its own process. The worker reliably produces its output
// (stdout for voices, the WAV file for speak) but then crashes during teardown
// with "mutex lock failed" — onnxruntime-node's thread-pool destructor under
// Electron-as-Node. That crash is AFTER the work is done, so we never reject on
// exit code here; callers validate the actual output and ignore the teardown noise.
function runWorker(args: string[], stdin?: string): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath(), ...args], {
      cwd: app.getAppPath(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ out, err, code: code ?? 0 }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

// onnxruntime's harmless teardown crash — not a real failure if output exists.
function isTeardownNoise(err: string): boolean {
  return /mutex lock failed|Session already disposed|libc\+\+abi/i.test(err);
}

let busy = false;

/** Synthesize speech for `text`; returns a WAV data URL. */
export async function synthesize(text: string, voice?: string): Promise<{ dataUrl: string }> {
  // Caller's voice wins; else the user-selected speech voice IF it's a real voice
  // name (e.g. "af_heart") and not a model id; else default. Guarded so picking a
  // model in the UI can never feed the engine an invalid voice.
  const sel = getActiveModal('speech');
  voice = voice || (sel && /^[a-z]{2}_[a-z]+$/i.test(sel) ? sel : null) || DEFAULT_VOICE;
  const t = (text || '').trim();
  if (!t) throw new Error('Nothing to speak.');
  if (busy) throw new Error('Already generating speech — please wait.');
  busy = true;
  const out = path.join(os.tmpdir(), `offgrid-tts-${process.pid}-${Date.now()}.wav`);
  console.log(`[tts] synth start: voice=${voice || DEFAULT_VOICE} chars=${t.length} worker=${(() => { try { return workerPath(); } catch { return '??'; } })()}`);
  const t0 = Date.now();
  try {
    const { err, code } = await runWorker(['speak', out, voice || DEFAULT_VOICE], t);
    // Success = a real WAV on disk (>44-byte header), regardless of exit code.
    let wav: Buffer | null = null;
    let size = 0;
    try {
      const buf = await fs.promises.readFile(out);
      size = buf.length;
      if (buf.length > 44) wav = buf;
    } catch {
      /* no file */
    }
    console.log(`[tts] worker done in ${Date.now() - t0}ms exitCode=${String(code)} wavBytes=${size} stderr=${err.trim().slice(0, 300)}`);
    if (!wav) throw new Error(err.trim() || `tts worker failed (exit ${String(code)})`);
    console.log(`[tts] returning dataUrl (${wav.length} bytes)`);
    return { dataUrl: `data:audio/wav;base64,${wav.toString('base64')}` };
  } catch (e) {
    console.error('[tts] synth failed:', (e as Error).message);
    throw e;
  } finally {
    busy = false;
    fs.promises.unlink(out).catch(() => {});
  }
}

let voicesCache: string[] | null = null;

/** Available voice ids (e.g. af_heart, af_bella, am_michael, …). */
export async function listVoices(): Promise<string[]> {
  if (voicesCache) return voicesCache;
  const { out, err } = await runWorker(['voices']);
  let voices: string[] = [];
  try {
    const parsed = JSON.parse(out.trim());
    if (Array.isArray(parsed)) voices = parsed;
  } catch {
    /* fall through */
  }
  if (!voices.length && !isTeardownNoise(err)) throw new Error(err.trim() || 'failed to list voices');
  voicesCache = voices;
  return voices;
}
