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

import fs from 'node:fs'
import path from 'node:path'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const DEFAULT_VOICE = 'af_heart'
const PROGRESS_PREFIX = 'OFFGRID_TTS_PROGRESS '

const worker = {
  log(event, fields = {}) {
    const details = Object.entries(fields)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(' ')
    process.stderr.write(
      `${new Date().toISOString()} INFO [tts-worker] ${event}${details ? ` ${details}` : ''}\n`
    )
  },

  progress(event) {
    if (event?.status !== 'progress' || !Number.isFinite(event.progress)) return
    const value = event.progress <= 1 ? event.progress * 100 : event.progress
    process.stderr.write(
      `${PROGRESS_PREFIX}${JSON.stringify({ file: event.file, progress: Math.max(0, Math.min(100, value)) })}\n`
    )
  },

  /**
   * @param {string} target
   * @param {(string | null | undefined)[]} sources
   * @returns {boolean}
   */
  materializeRuntimeFile(target, sources) {
    if (fs.existsSync(target)) return false
    const source = sources.find((candidate) => candidate && fs.existsSync(candidate))
    if (!source) return false
    fs.mkdirSync(path.dirname(target), { recursive: true })
    try {
      fs.linkSync(source, target)
    } catch {
      fs.copyFileSync(source, target)
    }
    return true
  },

  /**
   * @param {{ cacheDir?: string }} transformersEnv
   * @returns {void}
   */
  configureWritableCache(transformersEnv) {
    const writableCache = process.env.OFFGRID_TTS_CACHE_DIR
    if (!writableCache) return
    const bundledCache = transformersEnv.cacheDir
    const relativeFiles = [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx'
    ]
    let materialized = 0
    for (const relative of relativeFiles) {
      const target = path.join(writableCache, MODEL_ID, relative)
      const bundled = bundledCache ? path.join(bundledCache, MODEL_ID, relative) : null
      const downloaded =
        relative === 'onnx/model_quantized.onnx' ? process.env.OFFGRID_TTS_MODEL_FILE : null
      if (worker.materializeRuntimeFile(target, [downloaded, bundled])) materialized++
    }
    transformersEnv.cacheDir = writableCache
    worker.log('cache.configured', { writable: true, materialized })
  },

  // kokoro-js' RawAudio.toWav() emits 32-bit IEEE-float WAV (format 3), which
  // Chromium's <audio>/new Audio() refuses to decode — so playback is silent.
  // Re-encode the float samples to 16-bit PCM, which plays everywhere.
  /**
   * @param {Float32Array | number[]} float32
   * @param {number} sampleRate
   * @returns {Buffer}
   */
  encodeWavPcm16(float32, sampleRate) {
    const n = float32.length
    const buf = Buffer.alloc(44 + n * 2)
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + n * 2, 4)
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20) // PCM
    buf.writeUInt16LE(1, 22) // mono
    buf.writeUInt32LE(sampleRate, 24)
    buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
    buf.writeUInt16LE(2, 32) // block align
    buf.writeUInt16LE(16, 34) // bits per sample
    buf.write('data', 36)
    buf.writeUInt32LE(n * 2, 40)
    let off = 44
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]))
      buf.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, off)
      off += 2
    }
    return buf
  },

  /**
   * @param {{ generate: (text: string, options: { voice: string }) => Promise<{ audio?: Float32Array, data?: Float32Array, sampling_rate?: number, sampleRate?: number }> }} tts
   * @param {string} text
   * @param {string} voice
   * @param {string} outPath
   * @returns {Promise<void>}
   */
  async synthToFile(tts, text, voice, outPath) {
    const clean = (text || '').trim().slice(0, 2000)
    if (!clean) throw new Error('no text')
    const started = Date.now()
    worker.log('synthesis.started', { chars: clean.length })
    const audio = await tts.generate(clean, { voice: voice || DEFAULT_VOICE })
    const samples = audio.audio || audio.data
    const sr = audio.sampling_rate || audio.sampleRate || 24000
    const wav = worker.encodeWavPcm16(samples, sr)
    fs.writeFileSync(outPath, wav)
    worker.log('synthesis.completed', { durationMs: Date.now() - started, wavBytes: wav.length })
  },

  /** @returns {Promise<{ persist: boolean }>} */
  async main() {
    const mode = process.argv[2]
    worker.log('process.started', { mode, pid: process.pid })
    const [{ KokoroTTS }, { env: transformersEnv }] = await Promise.all([
      import('kokoro-js'),
      import('@huggingface/transformers')
    ])
    worker.log('dependency.loaded', { kokoro: typeof KokoroTTS?.from_pretrained === 'function' })
    if (mode === 'probe') {
      process.stdout.write(
        JSON.stringify({ kokoro: typeof KokoroTTS?.from_pretrained === 'function' })
      )
      return { persist: false }
    }
    worker.configureWritableCache(transformersEnv)
    const loadStarted = Date.now()
    worker.log('model.loading', { model: MODEL_ID, dtype: 'q8', device: 'cpu' })
    const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: 'q8',
      device: 'cpu',
      progress_callback: (event) => worker.progress(event)
    })
    worker.log('model.ready', { durationMs: Date.now() - loadStarted })

    if (mode === 'voices') {
      const voices = Object.entries(tts.voices || {}).map(([id, metadata]) => ({
        id,
        label: metadata.name,
        language: metadata.language?.replace(
          /^([a-z]{2})-([a-z]{2})$/i,
          (_, language, region) => `${language.toLowerCase()}-${region.toUpperCase()}`
        )
      }))
      worker.log('voices.completed', { count: voices.length })
      process.stdout.write(JSON.stringify(voices))
      return { persist: false }
    }

    if (mode === 'speak') {
      const outPath = process.argv[3]
      const voice = process.argv[4] || DEFAULT_VOICE
      if (!outPath) throw new Error('speak mode requires an output path')
      let text = ''
      process.stdin.setEncoding('utf8')
      for await (const chunk of process.stdin) text += chunk
      await worker.synthToFile(tts, text, voice, outPath)
      return { persist: false }
    }

    if (mode === 'serve') {
      // RESIDENT mode: the model stays loaded; the main process streams one JSON
      // request per line on stdin ({ id, text, voice, out }) and we reply with one
      // JSON line per request ({ id, ok } or { id, error }). Stays alive until the
      // parent kills us (the queue's evict), so the ~330MB model is warm across calls.
      process.stdout.write(JSON.stringify({ ready: true }) + '\n')
      let buf = ''
      process.stdin.setEncoding('utf8')
      for await (const chunk of process.stdin) {
        buf += chunk
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let req
          try {
            req = JSON.parse(line)
          } catch {
            continue
          }
          try {
            await worker.synthToFile(tts, req.text, req.voice, req.out)
            process.stdout.write(JSON.stringify({ id: req.id, ok: true }) + '\n')
          } catch (e) {
            process.stdout.write(
              JSON.stringify({ id: req.id, error: String(e && e.message ? e.message : e) }) + '\n'
            )
          }
        }
      }
      return { persist: true } // stdin closed -> parent is done with us
    }

    throw new Error(`unknown mode: ${String(mode)}`)
  },

  // onnxruntime-node crashes (SIGABRT, "mutex lock failed") inside its static
  // destructors during a normal exit() — which pops the macOS crash reporter even
  // though our work is already done and flushed. Hard-exit with SIGKILL instead:
  // it skips the C++ destructors entirely, so no crash dialog. Output (the WAV file
  // or stdout JSON) is written synchronously before we get here; give pipes a brief
  // tick to flush, then kill.
  /** @returns {void} */
  hardExit() {
    setTimeout(() => {
      try {
        process.kill(process.pid, 'SIGKILL')
      } catch {
        process.exit(0)
      }
    }, 40)
  }
}

worker
  .main()
  .then(() => worker.hardExit())
  .catch((e) => {
    process.stderr.write(String(e && e.stack ? e.stack : e))
    worker.hardExit()
  })
