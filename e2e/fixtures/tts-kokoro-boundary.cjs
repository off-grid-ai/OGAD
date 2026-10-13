/** Only the external native model is fake. The ONNX worker, WAV encoder, IPC,
 * markdown cleanup, and renderer audio player remain production code. */
/* eslint-disable @typescript-eslint/no-require-imports -- Node preloads this native-model boundary in the main process and its workers. */
const Module = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const threads = require('node:worker_threads')
const originalLoad = Module._load
Module._load = function (id, ...args) {
  if (id === 'node:worker_threads' && threads.isMainThread) {
    return {
      ...threads,
      Worker: class extends threads.Worker {
        constructor(entry, options) {
          // Keep the real OS worker. Load the external model fake in its own Node realm.
          super(
            entry,
            path.basename(String(entry)) === 'tts-onnx-worker.js'
              ? { ...options, execArgv: ['--require', __filename] }
              : options
          )
        }
      }
    }
  }
  if (id !== 'kokoro-js') return originalLoad.call(this, id, ...args)
  return {
    KokoroTTS: {
      async from_pretrained() {
        return {
          async generate(text) {
            fs.writeFileSync(process.env.OFFGRID_TTS_CAPTURE, text)
            const sampling_rate = 16_000
            const data = Float32Array.from(
              { length: sampling_rate * 10 },
              (_, index) => Math.sin((index / sampling_rate) * Math.PI * 440) * 0.12
            )
            return { data, sampling_rate }
          },
          model: {
            async dispose() {
              return undefined
            }
          }
        }
      }
    }
  }
}

if (threads.isMainThread) {
  // Electron does not inherit Node --require options from trailing app arguments.
  // Start the real app here and give its real worker threads the same model boundary.
  const { app } = require('electron')
  app.setAppPath(path.resolve(__dirname, '../..'))
  require('../../out/main/index.js')
}
