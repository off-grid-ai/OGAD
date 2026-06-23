// Isolated TTS worker — runs Kokoro-82M via kokoro-js in its OWN process so its
// onnxruntime-node (bundled by @huggingface/transformers) never collides with the
// onnxruntime-node that @xenova/transformers loads in the main process (loading
// two native ORT builds in one process throws "Session already disposed").
//
// Running it as a short-lived subprocess also means the ~330MB model is only
// resident while speaking and is reclaimed the moment we exit — true swap-in/out.
//
// Launched via Electron's binary with ELECTRON_RUN_AS_NODE=1 so the native ABI
// matches the app.  Usage:
//   tts-worker.mjs voices            -> prints JSON array of voice ids to stdout
//   tts-worker.mjs speak <out> <voice>  -> reads text from stdin, writes WAV to <out>

import fs from 'node:fs';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE = 'af_heart';

// kokoro-js' RawAudio.toWav() emits 32-bit IEEE-float WAV (format 3), which
// Chromium's <audio>/new Audio() refuses to decode — so playback is silent.
// Re-encode the float samples to 16-bit PCM, which plays everywhere.
function encodeWavPcm16(float32, sampleRate) {
  const n = float32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);            // block align
  buf.writeUInt16LE(16, 34);           // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, off);
    off += 2;
  }
  return buf;
}

async function main() {
  const mode = process.argv[2];
  const { KokoroTTS } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' });

  if (mode === 'voices') {
    const voices = Object.keys(tts.voices || {});
    process.stdout.write(JSON.stringify(voices));
    return;
  }

  if (mode === 'speak') {
    const outPath = process.argv[3];
    const voice = process.argv[4] || DEFAULT_VOICE;
    if (!outPath) throw new Error('speak mode requires an output path');
    let text = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) text += chunk;
    text = text.trim().slice(0, 2000);
    if (!text) throw new Error('no text on stdin');
    const audio = await tts.generate(text, { voice });
    const samples = audio.audio || audio.data;
    const sr = audio.sampling_rate || audio.sampleRate || 24000;
    process.stderr.write(`[tts-worker] samples=${samples ? samples.length : 0} sampleRate=${sr} -> 16-bit PCM\n`);
    const wav = encodeWavPcm16(samples, sr);
    fs.writeFileSync(outPath, wav);
    return;
  }

  throw new Error(`unknown mode: ${String(mode)}`);
}

// onnxruntime-node crashes (SIGABRT, "mutex lock failed") inside its static
// destructors during a normal exit() — which pops the macOS crash reporter even
// though our work is already done and flushed. Hard-exit with SIGKILL instead:
// it skips the C++ destructors entirely, so no crash dialog. Output (the WAV file
// or stdout JSON) is written synchronously before we get here; give pipes a brief
// tick to flush, then kill.
function hardExit() {
  setTimeout(() => {
    try { process.kill(process.pid, 'SIGKILL'); } catch { process.exit(0); }
  }, 40);
}

main()
  .then(() => hardExit())
  .catch((e) => {
    process.stderr.write(String(e && e.stack ? e.stack : e));
    hardExit();
  });
