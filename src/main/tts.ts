// On-device text-to-speech via Kokoro-82M (open-weight, Apache-2.0, multilingual).
//
// Kokoro runs through kokoro-js, which uses @huggingface/transformers' bundled
// onnxruntime-node. The main process ALSO loads @xenova/transformers (for
// embeddings), whose onnxruntime-node is a different build — and loading two
// native ORT runtimes in one process throws "Session already disposed". So we run
// Kokoro in a short-lived subprocess (Electron-as-Node) instead: it isolates the
// ORT runtime AND means the model is only resident while speaking, then freed —
// swap-in / swap-out rather than a permanent ~330MB resident session.

import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { getActiveModal } from './active-models'
import { applicationCodeFile, modelsDir } from './runtime-env'
import { getResidencyMode } from './runtime-residency'
import type { ManagedRuntime } from './runtime-manager'
import type { RuntimeSpeechVoice } from '@offgrid/speech'
import {
  DEFAULT_VOICE,
  chooseVoice,
  isTeardownNoise,
  parseRuntimeVoiceCatalog,
  parseServeLine,
  parseTtsProgressLine
} from './tts-logic'
import { writeDiagnosticLog } from './diagnostics-log'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function workerPath(): string {
  const found = applicationCodeFile('tts-worker.js', 'tts-worker.mjs')
  if (!found) throw new Error('TTS worker not found in trusted application resources.')
  return found
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    OFFGRID_TTS_CACHE_DIR: path.join(modelsDir(), '.cache', 'kokoro'),
    OFFGRID_TTS_MODEL_FILE: path.join(modelsDir(), 'kokoro-82m-v1.0.onnx')
  }
  delete env.ELECTRON_NO_ASAR
  return env
}

// Run the TTS worker in its own process. The worker reliably produces its output
// (stdout for voices, the WAV file for speak) but then crashes during teardown
// with "mutex lock failed" — onnxruntime-node's thread-pool destructor under
// Electron-as-Node. That crash is AFTER the work is done, so we never reject on
// exit code here; callers validate the actual output and ignore the teardown noise.
function runWorker(
  args: string[],
  stdin?: string,
  onProgress?: (progress: number) => void
): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve, reject) => {
    // No `cwd`: the worker gets an ABSOLUTE script path and Node resolves its deps
    // relative to that file, not cwd. A cwd of the app root breaks the packaged build -
    // app.getAppPath() is `app.asar` (a FILE), and spawn throws ENOTDIR on a non-dir cwd.
    // Matches how STT spawns (no cwd). This was the live "spawn ENOTDIR" TTS failure.
    const mode = args[0] || 'unknown'
    const worker = workerPath()
    writeDiagnosticLog('tts', 'worker.spawn', { mode, worker, runtime: process.execPath })
    const child = spawn(process.execPath, [worker, ...args], {
      env: workerEnvironment()
    })
    let out = ''
    let err = ''
    let progressBuffer = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      err += text
      progressBuffer += text
      let newline: number
      while ((newline = progressBuffer.indexOf('\n')) >= 0) {
        const line = progressBuffer.slice(0, newline)
        progressBuffer = progressBuffer.slice(newline + 1)
        const progress = parseTtsProgressLine(line)
        if (progress !== null) onProgress?.(progress)
      }
    })
    child.on('error', (error) => {
      writeDiagnosticLog('tts', 'worker.spawn_failed', { mode, error: error.message }, 'error')
      reject(error)
    })
    child.on('close', (code, signal) => {
      writeDiagnosticLog('tts', 'worker.closed', {
        mode,
        code,
        signal,
        stderr: err.trim() || undefined
      })
      resolve({ out, err, code: code ?? 0 })
    })
    if (stdin !== undefined) {
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}

let busy = false

// ---- resident mode: a persistent worker that keeps Kokoro warm ----------------
// In 'resident' mode we spawn ONE long-lived worker ('serve') that loads the model
// once and answers many synth requests over stdin/stdout (NDJSON). evict() kills it
// to free ~330MB; the queue re-warms it (resident) or leaves it dead (on-demand,
// where each synth uses the one-shot path below instead).
let serveChild: ChildProcess | null = null
let serveReady: Promise<void> | null = null
let serveStdout = ''
let reqSeq = 0
const servePending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()
// Free the ~330MB worker after this long idle even in resident mode - nothing in the
// queue evicts 'tts' today (only image/chat declare evicts), so without this the
// worker would live for the whole session. Mirrors sd-server / whisper-server idle-evict.
const SERVE_IDLE_MS = 5 * 60_000
const SERVE_REQ_TIMEOUT_MS = 60_000 // a single synth shouldn't take longer; guards a hung worker
let serveIdleTimer: ReturnType<typeof setTimeout> | null = null
function armIdleEvict(): void {
  if (serveIdleTimer) clearTimeout(serveIdleTimer)
  serveIdleTimer = setTimeout(() => stopServe(), SERVE_IDLE_MS)
  serveIdleTimer.unref()
}
function clearIdleEvict(): void {
  if (serveIdleTimer) {
    clearTimeout(serveIdleTimer)
    serveIdleTimer = null
  }
}

function startServe(): Promise<void> {
  if (serveReady !== null) {
    writeDiagnosticLog('tts', 'resident.reused')
    return serveReady
  }
  serveReady = new Promise<void>((resolve, reject) => {
    // No `cwd` - see runWorker: an asar-file cwd throws ENOTDIR in the packaged build.
    const worker = workerPath()
    writeDiagnosticLog('tts', 'resident.starting', { worker, runtime: process.execPath })
    const child = spawn(process.execPath, [worker, 'serve'], {
      env: workerEnvironment()
    })
    serveChild = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      serveStdout += d
      let nl: number
      while ((nl = serveStdout.indexOf('\n')) >= 0) {
        const line = serveStdout.slice(0, nl)
        serveStdout = serveStdout.slice(nl + 1)
        const msg = parseServeLine(line)
        if (!msg) {
          writeDiagnosticLog('tts', 'resident.protocol_ignored', { line }, 'warn')
          continue
        }
        if (msg.ready) {
          writeDiagnosticLog('tts', 'resident.ready', { pid: child.pid })
          resolve()
          continue
        }
        const p = msg.id != null ? servePending.get(msg.id) : undefined
        if (p && msg.id != null) {
          servePending.delete(msg.id)
          if (msg.ok) {
            writeDiagnosticLog('tts', 'resident.request_completed', { requestId: msg.id })
            p.resolve()
          } else {
            writeDiagnosticLog(
              'tts',
              'resident.request_failed',
              { requestId: msg.id, error: msg.error || 'tts worker error' },
              'error'
            )
            p.reject(new Error(msg.error || 'tts worker error'))
          }
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (data: string) => {
      for (const line of data.split(/\r?\n/).filter(Boolean)) {
        writeDiagnosticLog('tts.worker', 'stderr', { message: line }, 'warn')
      }
    })
    child.on('error', (error) => {
      writeDiagnosticLog('tts', 'resident.spawn_failed', { error: error.message }, 'error')
      reject(error)
    })
    child.on('close', (code, signal) => {
      writeDiagnosticLog('tts', 'resident.closed', { code, signal })
      serveChild = null
      serveReady = null
      for (const p of servePending.values()) p.reject(new Error('tts worker exited'))
      servePending.clear()
    })
  })
  return serveReady
}

function stopServe(): void {
  clearIdleEvict()
  const c = serveChild
  serveChild = null
  serveReady = null
  if (c) {
    writeDiagnosticLog('tts', 'resident.stopping', { pid: c.pid })
    try {
      c.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

/** Synthesize on the resident worker (model stays warm across calls). Bounded by a
 *  timeout so a hung worker rejects (and frees `busy`) instead of wedging TTS. */
async function synthResident(text: string, voice: string, out: string): Promise<void> {
  await startServe()
  clearIdleEvict() // busy now; re-arm when the request settles
  const c = serveChild
  if (!c?.stdin) throw new Error('tts worker not running')
  const id = String(++reqSeq)
  writeDiagnosticLog('tts', 'resident.request_started', {
    requestId: id,
    chars: text.length
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        servePending.delete(id)
        writeDiagnosticLog('tts', 'resident.request_timed_out', { requestId: id }, 'error')
        reject(new Error('tts worker timed out'))
      }, SERVE_REQ_TIMEOUT_MS)
      servePending.set(id, {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      c.stdin!.write(JSON.stringify({ id, text: text.slice(0, 2000), voice, out }) + '\n')
    })
  } finally {
    armIdleEvict() // idle again - free the model after SERVE_IDLE_MS
  }
}

/** TTS as a ManagedRuntime for the shared residency seam — same interface as every
 *  other engine. evict frees the resident worker; warm preloads it (resident); on-
 *  demand release just ensures no worker lingers (each synth spawns one-shot). */
export const ttsRuntime: ManagedRuntime = {
  modality: 'tts',
  evict: () => stopServe(),
  warm: () => {
    writeDiagnosticLog('tts', 'runtime.warm_requested')
    void startServe().catch((error) => {
      writeDiagnosticLog('tts', 'runtime.warm_failed', { error: messageOf(error) }, 'error')
    })
  },
  release: () => stopServe()
}

/** Synthesize speech for `text`; returns a WAV data URL. */
export async function synthesize(text: string, voice?: string): Promise<{ dataUrl: string }> {
  // Caller's voice wins; else the user-selected speech voice IF it's a real voice
  // name (e.g. "af_heart") and not a model id; else default. Guarded so picking a
  // model in the UI can never feed the engine an invalid voice.
  const sel = getActiveModal('speech')
  voice = chooseVoice(voice, sel)
  // Markdown -> speakable text is owned by the renderer (src/renderer/.../speakable.ts,
  // which reuses the chat UI's markdown AST). This service synthesizes PLAIN text only.
  const t = (text || '').trim()
  if (!t) throw new Error('Nothing to speak.')
  if (busy) throw new Error('Already generating speech — please wait.')
  busy = true
  const out = path.join(os.tmpdir(), `offgrid-tts-${process.pid}-${Date.now()}.wav`)
  const t0 = Date.now()
  const resident = getResidencyMode('tts') === 'resident'
  const requestId = `speak-${process.pid}-${t0}`
  writeDiagnosticLog('tts', 'request.started', {
    requestId,
    chars: t.length,
    mode: resident ? 'resident' : 'on-demand'
  })
  try {
    // Resident: reuse the warm worker (fast, model stays loaded). On-demand: spawn
    // a one-shot worker that frees the ~330MB model on exit. Same output either way.
    let err = ''
    if (resident) {
      try {
        await synthResident(t, voice || DEFAULT_VOICE, out)
      } catch (e) {
        err = (e as Error).message
      }
    } else {
      ;({ err } = await runWorker(['speak', out, voice || DEFAULT_VOICE], t))
    }
    // Success = a real WAV on disk (>44-byte header), regardless of exit code.
    let wav: Buffer | null = null
    let size = 0
    try {
      const buf = await fs.promises.readFile(out)
      size = buf.length
      if (buf.length > 44) wav = buf
    } catch {
      /* no file */
    }
    writeDiagnosticLog('tts', 'request.worker_finished', {
      requestId,
      durationMs: Date.now() - t0,
      mode: resident ? 'resident' : 'on-demand',
      wavBytes: size,
      stderr: err.trim() || undefined
    })
    if (!wav) throw new Error(err.trim() || 'tts worker failed')
    writeDiagnosticLog('tts', 'request.completed', {
      requestId,
      durationMs: Date.now() - t0,
      wavBytes: wav.length
    })
    return { dataUrl: `data:audio/wav;base64,${wav.toString('base64')}` }
  } catch (e) {
    writeDiagnosticLog(
      'tts',
      'request.failed',
      { requestId, durationMs: Date.now() - t0, error: messageOf(e) },
      'error'
    )
    throw e
  } finally {
    busy = false
    fs.promises.unlink(out).catch(() => {})
  }
}

let voiceCatalogCache: RuntimeSpeechVoice[] | null = null

/** Runtime voice metadata for selectors. The worker is the source of truth. */
export async function listVoiceCatalog(
  onProgress?: (progress: number) => void
): Promise<RuntimeSpeechVoice[]> {
  if (voiceCatalogCache) {
    writeDiagnosticLog('tts', 'voices.cache_hit', { count: voiceCatalogCache.length })
    onProgress?.(100)
    return voiceCatalogCache
  }
  writeDiagnosticLog('tts', 'voices.requested')
  const { out, err } = await runWorker(['voices'], undefined, onProgress)
  const voices = parseRuntimeVoiceCatalog(out.trim())
  if (!voices.length && !isTeardownNoise(err))
    throw new Error(err.trim() || 'failed to list voices')
  voiceCatalogCache = voices
  writeDiagnosticLog('tts', 'voices.completed', { count: voices.length })
  return voices
}

/** Available voice ids for the OpenAI-compatible model endpoint. */
export async function listVoices(onProgress?: (progress: number) => void): Promise<string[]> {
  return (await listVoiceCatalog(onProgress)).map(({ id }) => id)
}
