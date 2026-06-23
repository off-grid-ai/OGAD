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
    const wav = audio.toWav();
    fs.writeFileSync(outPath, Buffer.from(wav));
    return;
  }

  throw new Error(`unknown mode: ${String(mode)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    process.stderr.write(String(e && e.stack ? e.stack : e));
    process.exit(1);
  });
