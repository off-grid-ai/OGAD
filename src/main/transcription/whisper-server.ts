// Resident whisper.cpp HTTP server (the bundled `whisper-server`).
//
// Unlike the one-shot whisper-cli in whisper-cli.ts (which spawns, RELOADS the
// whole ggml model from disk on EVERY call - ~3.3s - transcribes once, and exits),
// this keeps ONE model resident across requests: loaded once at launch, stays warm.
// Live/sliding-window dictation fires an interim transcription every few hundred ms;
// paying the model reload each tick makes it thrash and lag, so the resident server
// is the difference between true live text and a stutter.
//
// Mirrors sd-server.ts / llm.ts lifecycle: spawn on a fixed localhost port, wait
// for readiness over HTTP, restart on a model swap or crash, evict after an idle
// window (freeing the model's memory), and stop on host quit. Whisper models are
// small (a base model is ~150MB) so the idle window is generous - the memory
// pressure that forces the image server to evict aggressively doesn't apply here.
//
// SOLID: the process lifecycle + HTTP client live in WhisperServerService; the
// pure request/arg/parse shaping is extracted into exported functions (unit-tested,
// zero-IO), exactly as whisper-cli.ts extracts model resolution and parseSegments.
import { spawn, type ChildProcess, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { binRoots, isPackaged, exe } from '../runtime-env'
import { existing } from './bin-resolution'
import { whisperModel, ffmpegBin } from './whisper-cli'
import { decodeToWavArgs, DECODE_TIMEOUT_MS } from './ffmpeg-decode'
import type { TranscriptionService, Transcript, TranscribeOptions } from './types'
import { killOrphansOnPort as reapOrphansOnPort } from '../kill-orphan-port'
import { runNativeTranscriptionProcess } from './native-process'

// Off the LLM (8439) and image (8440) ports so the resident STT engine can bind
// alongside them - they may all be warm at once (chat + dictation together).
const WHISPER_SERVER_PORT = 8441

/** Launch-time context that pins the resident model. A change here means the
 *  server must be restarted to take effect (part of the context key). */
export interface WhisperServerContext {
  /** Absolute path to the ggml whisper model (`-m`). */
  modelPath: string
  /** Inference threads (`-t`). Defaults to cpus-2, floored at 1. */
  threads?: number
  port?: number
}

/** Per-request inference params (maps to the /inference multipart form). */
export interface WhisperInferenceRequest {
  /** Absolute path to a 16 kHz mono WAV to transcribe. */
  wavPath: string
  /** Spoken-language hint; 'auto' detects. Default 'auto'. */
  language?: string
  /** Initial prompt biasing recognition toward custom vocabulary. */
  prompt?: string
  /** Aborts the request and response body. The shared server has no per-job native cancel API. */
  signal?: AbortSignal
}

/** Build the whisper-server launch argv (context/model args only; per-request
 *  params are sent over HTTP). Pure. Mirrors buildSdServerContextArgs. */
export function buildWhisperServerArgs(ctx: WhisperServerContext): string[] {
  const args = [
    '-m',
    ctx.modelPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(ctx.port ?? WHISPER_SERVER_PORT),
    '-t',
    String(ctx.threads ?? Math.max(1, os.cpus().length - 2))
  ]
  return args
}

/** A stable key identifying a resident configuration - the server is restarted
 *  when this changes (model swap, thread change). Pure. */
export function whisperContextKey(ctx: WhisperServerContext): string {
  return JSON.stringify([ctx.modelPath, ctx.threads ?? null, ctx.port ?? WHISPER_SERVER_PORT])
}

/** The multipart form fields for POST /inference. whisper-server takes the audio
 *  as a `file` part plus text fields; we always ask for `json` so parsing is
 *  deterministic. The audio file itself is attached by the caller (it can't live
 *  in a pure builder). `language` is omitted when 'auto' so the server detects.
 *  Pure - returns the field map, not a wire body. */
export function buildInferenceFields(req: WhisperInferenceRequest): Record<string, string> {
  const fields: Record<string, string> = { response_format: 'json' }
  const lang = (req.language ?? 'auto').trim()
  if (lang && lang !== 'auto') fields.language = lang
  const prompt = (req.prompt ?? '').trim()
  if (prompt) fields.prompt = prompt.slice(0, 800)
  return fields
}

/** Parse whisper-server's /inference JSON response into a Transcript-shaped
 *  { text }. The server returns { "text": "..." } for response_format=json; some
 *  builds nest it or return an OpenAI-style { text }. A malformed/empty body
 *  yields empty text rather than throwing, so a bad interim tick degrades to
 *  "no text yet" instead of erroring the dictation loop. Pure. */
export function parseInferenceResponse(body: unknown): { text: string } {
  if (typeof body === 'string') {
    // Non-JSON (plain text) response: use it verbatim.
    return { text: body.trim() }
  }
  const b = (body ?? {}) as Record<string, unknown>
  // Direct { text } (the json/verbose_json shapes).
  if (typeof b.text === 'string') return { text: b.text.trim() }
  // Some builds return segments only; join their texts.
  if (Array.isArray(b.segments)) {
    const text = b.segments
      .map((s) =>
        s && typeof s === 'object' ? String((s as Record<string, unknown>).text ?? '') : ''
      )
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    return { text }
  }
  return { text: '' }
}

/** The resident whisper server. One instance (the exported `whisperServer`). */
class WhisperServerService {
  private server: ChildProcess | null = null
  private port = WHISPER_SERVER_PORT
  private activeKey: string | null = null // whisperContextKey of the loaded model, null when down
  private startPromise: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private idleMs = 5 * 60_000 // keep the model hot for 5 min of inactivity, then evict
  private stderrTail: string[] = []

  /** Tune the idle window (mainly for tests). */
  setIdleMs(ms: number): void {
    this.idleMs = ms
  }

  isUp(): boolean {
    return this.server !== null && this.activeKey !== null
  }

  private base(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** Resolve the bundled whisper-server binary across dev / packaged layouts. */
  findBinary(): string | null {
    // Shared first-existing-path resolver (bin-resolution), instead of a hand-rolled
    // existsSync loop that duplicated it. exe() adds the .exe suffix on Windows.
    return existing(binRoots().map((r) => path.join(r, 'whisper-server', exe('whisper-server'))))
  }

  /** Ensure a server is up with EXACTLY this context; restart on a model/thread
   *  swap. Cancels any pending idle-eviction (we're about to be busy). */
  async ensureUp(ctx: WhisperServerContext): Promise<void> {
    this.clearIdleTimer()
    const key = whisperContextKey({ ...ctx, port: this.port })
    if (this.server && this.activeKey === key) return // already the right model
    if (this.server && this.activeKey !== key) this.stopProcess() // swap -> restart
    if (this.startPromise !== null) return this.startPromise
    this.startPromise = this.spawn(ctx, key).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async spawn(ctx: WhisperServerContext, key: string): Promise<void> {
    const bin = this.findBinary()
    if (!bin)
      throw new Error(
        'Resident STT engine (whisper-server) not found in resources/bin/whisper-server.'
      )
    if (!fs.existsSync(ctx.modelPath))
      throw new Error(`Transcription model not found: ${ctx.modelPath}`)
    const binDir = path.dirname(bin)

    // Downloaded DMGs are quarantined; clear it on packaged builds (mirrors llm.ts / sd-server.ts).
    if (isPackaged() && process.platform === 'darwin') {
      try {
        execSync(`xattr -cr "${binDir}"`, { stdio: 'ignore' })
        execSync(`chmod +x "${bin}"`, { stdio: 'ignore' })
      } catch {
        /* best effort */
      }
    }

    // Kill an orphaned whisper-server from a prior app process still holding the
    // port, but never a foreign process that merely happened to bind it.
    this.killOrphanOnPort()

    const args = buildWhisperServerArgs({ ...ctx, port: this.port })
    // cwd at the binary dir so @rpath resolves the co-located libwhisper/libggml dylibs.
    const proc = spawn(bin, args, {
      cwd: binDir,
      // macOS: rpath for the co-located dylibs. Windows: prepend binDir to PATH so
      // the ggml/whisper DLLs next to the exe resolve.
      env: {
        ...process.env,
        DYLD_LIBRARY_PATH: binDir,
        ...(process.platform === 'win32'
          ? { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` }
          : {})
      }
    })
    this.server = proc
    this.stderrTail = []
    const capture = (d: Buffer): void => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) this.stderrTail.push(line)
      if (this.stderrTail.length > 50) this.stderrTail = this.stderrTail.slice(-50)
    }
    proc.stdout.on('data', capture)
    proc.stderr.on('data', capture)
    proc.on('close', () => {
      if (this.server !== proc) return // an already-replaced instance
      this.server = null
      this.activeKey = null
    })

    await this.waitForReady()
    this.activeKey = key
  }

  private async waitForReady(timeoutMs = 60_000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (!this.server) {
        throw new Error(
          `whisper-server exited during startup: ${this.stderrTail.slice(-6).join(' | ')}`
        )
      }
      try {
        // whisper-server serves an HTML page at / once the model is loaded and it's
        // listening. A 2xx means the socket is up and the model finished loading.
        const res = await fetch(`${this.base()}/`)
        if (res.ok) return
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error('whisper-server failed to become ready in time.')
  }

  /** Transcribe a 16 kHz mono WAV on the resident server. Assumes ensureUp() has
   *  already loaded the intended model. */
  async inference(req: WhisperInferenceRequest): Promise<Transcript> {
    this.clearIdleTimer()
    try {
      const fields = buildInferenceFields(req)
      const form = new FormData()
      const bytes = await fs.promises.readFile(req.wavPath, { signal: req.signal })
      // FormData wants a Blob; the audio part is named `file` (whisper-server's field).
      form.append('file', new Blob([bytes], { type: 'audio/wav' }), path.basename(req.wavPath))
      for (const [k, v] of Object.entries(fields)) form.append(k, v)

      const res = await fetch(`${this.base()}/inference`, {
        method: 'POST',
        body: form,
        signal: req.signal
      })
      if (!res.ok) throw new Error(`whisper-server rejected the request (HTTP ${res.status}).`)
      // Prefer JSON; fall back to raw text so a plain-text build still parses.
      const ctype = res.headers.get('content-type') ?? ''
      const body: unknown = ctype.includes('application/json') ? await res.json() : await res.text()
      const { text } = parseInferenceResponse(body)
      const lang = req.language && req.language !== 'auto' ? req.language : undefined
      return { text, language: lang }
    } finally {
      this.armIdleTimer()
    }
  }

  /** Stop the server now (model swap, shutdown, or memory reclaim). */
  stop(): void {
    this.clearIdleTimer()
    this.stopProcess()
  }

  private stopProcess(): void {
    if (this.server) {
      try {
        this.server.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      this.server = null
    }
    this.activeKey = null
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.stop()
    }, this.idleMs)
    // Don't let the eviction timer keep the Node event loop (or a test) alive.
    ;(this.idleTimer as unknown as { unref?: () => void }).unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private killOrphanOnPort(): void {
    // Shared cross-platform reaper (kill-orphan-port.ts) — adds the Windows branch this
    // used to lack (a crashed whisper-server would keep holding the port after a restart).
    // Match policy: posix matches our OWN bundled binary by FULL PATH (a user's separately
    // run whisper-server is left untouched); win32's tasklist only exposes the image name,
    // so match the exe name there.
    const ownBin = this.findBinary()
    if (!ownBin) return
    reapOrphansOnPort(
      this.port,
      (info) =>
        process.platform === 'win32' ? /whisper-server/i.test(info) : info.includes(ownBin),
      'whisper-server'
    )
  }
}

/** Shared singleton - callers depend on this, not on the class. */
export const whisperServer = new WhisperServerService()

/** TranscriptionService backed by the resident whisper-server. Same contract as
 *  WhisperCliTranscription (isAvailable / transcribe), so it drops in behind the
 *  select.ts seam. When the server binary isn't staged, isAvailable() is false and
 *  select.ts degrades to the one-shot whisper-cli - exactly like Parakeet does. */
class WhisperServerTranscription implements TranscriptionService {
  constructor(private readonly svc: WhisperServerService = whisperServer) {}

  isAvailable(): boolean {
    // Available only when BOTH the resident binary and a whisper ggml model exist.
    // (whisperModel() returns null when no ggml model is downloaded.)
    return !!this.svc.findBinary() && !!whisperModel()
  }

  async transcribe(input: { path: string }, opts: TranscribeOptions = {}): Promise<Transcript> {
    opts.signal?.throwIfAborted()
    const model =
      opts.model && path.isAbsolute(opts.model) && fs.existsSync(opts.model)
        ? opts.model
        : whisperModel()
    if (!model)
      throw new Error('No transcription model found - download Whisper from Models first.')

    // Ensure the resident server is warm on the intended model (loads once; a
    // subsequent call with the same model is a no-op).
    await this.svc.ensureUp({ modelPath: model })
    opts.signal?.throwIfAborted()

    // The server expects a decoded 16 kHz mono WAV. Reuse the exact ffmpeg re-encode
    // whisper-cli.ts uses; skip it when the caller pre-converted (dictation interim ticks).
    let wav = input.path
    let tmp: string | null = null
    if (!opts.alreadyWav16k) {
      const ff = ffmpegBin()
      if (!ff) throw new Error('ffmpeg is required to decode audio and was not found.')
      tmp = path.join(os.tmpdir(), `offgrid-stt-srv-${Date.now()}-${process.pid}.wav`)
      try {
        await runNativeTranscriptionProcess(ff, decodeToWavArgs(input.path, tmp), {
          timeout: DECODE_TIMEOUT_MS,
          signal: opts.signal
        })
      } catch (e) {
        fs.promises.unlink(tmp).catch(() => {})
        throw e
      }
      wav = tmp
    }

    try {
      return await this.svc.inference({
        wavPath: wav,
        language: opts.language,
        prompt: opts.prompt,
        signal: opts.signal
      })
    } finally {
      if (tmp) fs.promises.unlink(tmp).catch(() => {})
    }
  }
}

/** Shared singleton for the resident-whisper TranscriptionService. */
export const whisperServerTranscription: TranscriptionService = new WhisperServerTranscription()
