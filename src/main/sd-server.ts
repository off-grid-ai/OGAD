// Persistent stable-diffusion.cpp server (the bundled `sd-server`).
//
// Unlike the one-shot `sd-cli` in imagegen.ts (which spawns, loads the whole
// model from disk, compiles Metal shaders, generates ONE image, and exits), this
// keeps ONE model resident across images. The payoff on Apple Silicon is large
// and measured: on an M4 the first image after launch pays a ~13s Metal
// shader-compile warmup + a ~5s model load, but every image after that skips
// BOTH — ~7s warm vs ~45s cold for the same 512² / 4-step generation.
//
// Memory contract (Apple Silicon unified memory): the chat LLM (gemma) and an
// image model can NOT both be resident or the machine swaps and freezes — the
// same constraint imagegen.ts guards with llm.pause()/resume(). A resident image
// server would hold ~4GB indefinitely and starve chat, so this service does NOT
// stay up forever: after `idleMs` with no generation it evicts itself (kills the
// process, freeing the memory) and fires an eviction hook so the caller can warm
// the LLM back up. A burst of images stays hot; chat returns after the burst.
//
// SOLID: the process lifecycle + HTTP client live here; the pure request/arg/
// result shaping is extracted into exported functions (unit-tested, zero-IO).
import { spawn, type ChildProcess, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { binRoots, isPackaged, exe } from './runtime-env'
import { killOrphansOnPort as reapOrphansOnPort } from './kill-orphan-port'
import {
  desktopEngineIdleMs,
  engineReadinessAction,
  idleEvictionAction,
  modelReadinessIssue,
  residentEngineAction,
  residentEngineKey
} from '@offgrid/models'

/** Off the LLM's 8439 so both engines can bind (they never run at once, but a
 *  lingering LLM shouldn't block the image server's port either). */
const SD_SERVER_PORT = 8440

/** Context (launch-time) knobs that pin a resident model. A change here means the
 *  server must be restarted to take effect. */
export interface SdServerContext {
  /** Full model path (`-m`). Full-pipeline checkpoints only (this path doesn't
   *  handle the Z-Image 3-file stack or UNET-only+companions — those stay
   *  one-shot in imagegen.ts). */
  modelPath: string
  threads?: number
  /** Flash attention in the diffusion model — faster, lower memory. */
  diffusionFa?: boolean
  /** Optional TAESD decoder path — swaps the slow full VAE decode for the tiny
   *  autoencoder (sub-second decode). A launch-time arg, so toggling it restarts
   *  the resident server (it's part of the context key). */
  taesdPath?: string
  port?: number
}

/** Per-image generation request (maps to POST /sdcpp/v1/img_gen). */
export interface SdGenRequest {
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  seed?: number
  /** Classifier-free guidance text scale. cfg 1.0 disables CFG (one forward pass
   *  per step) — the fast, few-step turbo/lightning config. */
  cfgScale?: number
  sampleMethod?: string
  /** Denoiser sigma schedule (e.g. 'karras'). Essential for crisp few-step output. */
  scheduler?: string
}

/** Build the sd-server launch argv (context/model args only; generation params
 *  are sent per-request over HTTP). Pure. */
export function buildSdServerContextArgs(ctx: SdServerContext): string[] {
  const args = ['-m', ctx.modelPath, '--listen-port', String(ctx.port ?? SD_SERVER_PORT)]
  if (ctx.diffusionFa) args.push('--diffusion-fa')
  if (ctx.taesdPath) args.push('--taesd', ctx.taesdPath)
  args.push('-t', String(ctx.threads ?? Math.max(1, os.cpus().length - 2)))
  return args
}

/** A stable key identifying a resident configuration — the server is restarted
 *  when this changes (model swap, flag change). Pure. */
export function contextKey(ctx: SdServerContext): string {
  return residentEngineKey([
    ctx.modelPath,
    ctx.diffusionFa ?? false,
    ctx.taesdPath ?? null,
    ctx.threads ?? null,
    ctx.port ?? SD_SERVER_PORT
  ])
}

/** Build the JSON body for POST /sdcpp/v1/img_gen. The steps/method/guidance
 *  live in a NESTED `sample_params` object — a top-level `sample_steps` is
 *  silently ignored by sd-server (it falls back to its 20-step default). Pure. */
export function buildImgGenRequest(req: SdGenRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    negative_prompt: req.negativePrompt ?? '',
    width: req.width ?? 512,
    height: req.height ?? 512,
    sample_params: {
      sample_steps: req.steps ?? 8,
      sample_method: req.sampleMethod ?? 'dpm++2m',
      scheduler: req.scheduler ?? 'karras',
      guidance: { txt_cfg: req.cfgScale ?? 2.0 }
    }
  }
  if (typeof req.seed === 'number' && req.seed >= 0) body.seed = req.seed
  return body
}

export interface JobOutcome {
  /** True once the job reached a terminal state (completed or failed). */
  done: boolean
  ok: boolean
  /** Base64 PNG (no data: prefix) when ok. */
  pngBase64?: string
  error?: string
  /** Progress in [0,1] while running, if the server reported it. */
  progress?: number
  /** The seed the server actually used, when it reports one (so a random -1
   *  request can still be reproduced). Undefined if the server doesn't surface it. */
  seed?: number
}

/** Interpret a /sdcpp/v1/jobs/<id> status body into a terminal/partial outcome.
 *  Pure — no IO, so it's unit-testable against captured server payloads. */
export function parseJobResult(job: unknown): JobOutcome {
  const j = (job ?? {}) as Record<string, unknown>
  const status = String(j.status ?? '')
  const terminalOk = status === 'completed' || status === 'succeeded'
  const terminalFail = status === 'failed' || status === 'error' || status === 'cancelled'
  const progress = typeof j.progress === 'number' ? j.progress : undefined
  if (terminalOk) {
    const result = (j.result ?? {}) as Record<string, unknown>
    const images = Array.isArray(result.images) ? result.images : []
    const first = (images.find((x) => x && typeof x === 'object') ?? {}) as Record<string, unknown>
    const b64 = typeof first.b64_json === 'string' ? first.b64_json : undefined
    if (!b64)
      return { done: true, ok: false, error: 'server reported success but returned no image' }
    // Surface the seed the server actually used (on the job, its result, or the
    // image entry) so a random (-1) request stays reproducible. Undefined if absent.
    const seedRaw = j.seed ?? result.seed ?? first.seed
    const seed = typeof seedRaw === 'number' ? seedRaw : undefined
    return { done: true, ok: true, pngBase64: b64, progress, seed }
  }
  if (terminalFail) {
    const err = typeof j.error === 'string' && j.error ? j.error : `job ${status}`
    return { done: true, ok: false, error: err }
  }
  return { done: false, ok: false, progress }
}

/** Turn a REJECTED fetch to the resident sd-server into an ACTIONABLE message. A bare
 *  "fetch failed" (connection refused) means the server stopped accepting connections
 *  mid-job — it crashed, usually under memory pressure (image weights + the chat model on
 *  unified memory). Surface its recent stderr so the cause is visible instead of guessed —
 *  the same lesson as llama-error.ts (never let an engine die with an opaque error). Pure. */
export function describeSdFetchFailure(
  serverAlive: boolean,
  stderrTail: string[],
  raw: unknown
): string {
  const reason = serverAlive ? 'became unreachable' : 'crashed'
  const tail = stderrTail.slice(-6).join(' | ').trim()
  const rawMsg = raw instanceof Error ? raw.message : String(raw)
  return `sd-server ${reason} during image generation` + (tail ? `: ${tail}` : ` (${rawMsg})`)
}

interface SdGenProgress {
  step: number
  total: number
}

/** The resident image server. One instance (the exported `sdServer`). */
class SdServerService {
  private server: ChildProcess | null = null
  private port = SD_SERVER_PORT
  private activeKey: string | null = null // contextKey of the loaded model, null when down
  private startPromise: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private idleMs = desktopEngineIdleMs('image')
  private evictionHook: (() => void) | null = null
  private stderrTail: string[] = []
  private currentJobId: string | null = null

  /** Called after the server self-evicts on idle (or is stopped), so the caller
   *  can warm the LLM back up now that the image model's memory is freed. */
  setEvictionHook(fn: () => void): void {
    this.evictionHook = fn
  }

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

  /** fetch() to the resident server, but a REJECTION (server died mid-job) is re-thrown
   *  with the server's stderr tail so the failure is actionable, not an opaque "fetch
   *  failed" (the user-facing symptom we saw). A non-2xx response is left to the caller. */
  private async sdFetch(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init)
    } catch (e) {
      throw new Error(describeSdFetchFailure(this.server !== null, this.stderrTail, e))
    }
  }

  private findBinary(): string | null {
    for (const r of binRoots()) {
      const p = path.join(r, 'sd', exe('sd-server'))
      if (fs.existsSync(p)) return p
    }
    return null
  }

  /** Ensure a server is up with EXACTLY this context; restart on a model/flag
   *  swap. Cancels any pending idle-eviction (we're about to be busy). */
  async ensureUp(ctx: SdServerContext): Promise<void> {
    if (
      idleEvictionAction({ event: 'activity-started', processAlive: this.server !== null }) ===
      'cancel'
    )
      this.clearIdleTimer()
    const key = contextKey({ ...ctx, port: this.port })
    const action = residentEngineAction({
      processAlive: this.server !== null,
      activeKey: this.activeKey,
      requestedKey: key,
      startInFlight: this.startPromise !== null
    })
    if (action === 'reuse') return
    if (action === 'join-start') return this.startPromise!
    if (action === 'restart') this.stopProcess()
    this.startPromise = this.spawn(ctx, key).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async spawn(ctx: SdServerContext, key: string): Promise<void> {
    const bin = this.findBinary()
    if (!bin) throw new Error('Image server binary (sd-server) not found in resources/bin/sd.')
    const readinessIssue = modelReadinessIssue({
      primaryExists: fs.existsSync(ctx.modelPath),
      projectorRequired: false,
      projectorExists: false
    })
    if (readinessIssue === 'primary-missing')
      throw new Error(`Image model not found: ${ctx.modelPath}`)
    const binDir = path.dirname(bin)

    // Downloaded DMGs are quarantined; clear it on packaged builds (mirrors llm.ts).
    if (isPackaged() && process.platform === 'darwin') {
      try {
        execSync(`xattr -cr "${binDir}"`, { stdio: 'ignore' })
        execSync(`chmod +x "${bin}"`, { stdio: 'ignore' })
      } catch {
        /* best effort */
      }
    }

    // Kill an orphaned sd-server from a prior app process still holding the port,
    // but never a foreign process that merely happened to bind it.
    this.killOrphanOnPort()

    const args = buildSdServerContextArgs({ ...ctx, port: this.port })
    // cwd at the binary dir so @executable_path rpath resolves libstable-diffusion.dylib.
    // Windows: prepend binDir to PATH so the co-located stable-diffusion DLLs resolve.
    const proc = spawn(bin, args, {
      cwd: binDir,
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

  private async waitForReady(timeoutMs = 90_000): Promise<void> {
    const start = Date.now()
    for (;;) {
      let probeReady = false
      try {
        const res = await fetch(`${this.base()}/sdcpp/v1/capabilities`)
        probeReady = res.ok
      } catch {
        /* not up yet */
      }
      const action = engineReadinessAction({
        processAlive: this.server !== null,
        probeReady,
        elapsedMs: Date.now() - start,
        timeoutMs
      })
      if (action === 'ready') return
      if (action === 'failed')
        throw new Error(`sd-server exited during startup: ${this.stderrTail.slice(-6).join(' | ')}`)
      if (action === 'timed-out') throw new Error('sd-server failed to become ready in time.')
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  /** Generate one image on the resident server. Assumes ensureUp() already ran
   *  with the intended model. Returns the raw PNG bytes + the seed used. */
  async generate(
    req: SdGenRequest,
    onProgress?: (p: SdGenProgress) => void
  ): Promise<{ png: Buffer; seed: number }> {
    this.clearIdleTimer()
    const total = req.steps ?? 4
    try {
      const submit = await this.sdFetch(`${this.base()}/sdcpp/v1/img_gen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildImgGenRequest(req))
      })
      if (!submit.ok) throw new Error(`sd-server rejected the request (HTTP ${submit.status}).`)
      const job = (await submit.json()) as { id?: string; poll_url?: string }
      const pollUrl = job.poll_url ?? (job.id ? `/sdcpp/v1/jobs/${job.id}` : null)
      if (!pollUrl) throw new Error('sd-server did not return a job to poll.')
      this.currentJobId = job.id ?? null

      // Watchdog: abort if the job makes no progress for too long, so a hung
      // server can't wedge generation forever (the poll loop would otherwise spin
      // indefinitely). Reset the deadline whenever progress advances; a 1024²
      // image can legitimately take minutes, so the window is generous.
      const STALL_MS = 180_000
      let lastAdvanceAt = Date.now()
      let lastProgress = -1
      for (;;) {
        await new Promise((r) => setTimeout(r, 150))
        const res = await this.sdFetch(`${this.base()}${pollUrl}`)
        if (!res.ok) throw new Error(`job poll failed (HTTP ${res.status}).`)
        const status = await res.json()
        const outcome = parseJobResult(status)
        if (typeof outcome.progress === 'number' && outcome.progress > lastProgress) {
          lastProgress = outcome.progress
          lastAdvanceAt = Date.now()
        }
        if (onProgress && typeof outcome.progress === 'number') {
          onProgress({ step: Math.min(total, Math.round(outcome.progress * total)), total })
        }
        if (!outcome.done) {
          if (Date.now() - lastAdvanceAt > STALL_MS)
            throw new Error('image generation stalled (no progress) — aborting.')
          continue
        }
        if (!outcome.ok) throw new Error(outcome.error ?? 'image generation failed.')
        const png = Buffer.from(outcome.pngBase64!, 'base64')
        // Prefer the server-reported seed (for a reproducible -1 request); fall
        // back to the requested seed.
        return { png, seed: outcome.seed ?? req.seed ?? -1 }
      }
    } finally {
      this.currentJobId = null
      this.armIdleTimer()
    }
  }

  /** Cancel the in-flight job (if any) without tearing down the resident model. */
  async cancelCurrent(): Promise<boolean> {
    const id = this.currentJobId
    if (!id) return false
    try {
      await fetch(`${this.base()}/sdcpp/v1/jobs/${id}/cancel`, { method: 'POST' })
      return true
    } catch {
      return false
    }
  }

  /** Stop the server now (model swap, shutdown, or memory reclaim) and fire the
   *  eviction hook so the caller can warm the LLM back up. */
  stop(): void {
    this.clearIdleTimer()
    const wasUp = this.server !== null
    this.stopProcess()
    if (wasUp) this.evictionHook?.()
  }

  /** Kill the process without firing the eviction hook (used on internal swaps
   *  where a new spawn follows immediately). */
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
    if (
      idleEvictionAction({ event: 'activity-finished', processAlive: this.server !== null }) !==
      'arm'
    )
      return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (
        idleEvictionAction({ event: 'timer-fired', processAlive: this.server !== null }) === 'evict'
      )
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
    // used to lack (a crashed sd-server would keep holding the port after a restart).
    // posix matches our OWN bundled binary by FULL PATH (a user's separately-run sd-server
    // is left untouched); win32's tasklist only exposes the image name, so match that.
    const ownBin = this.findBinary()
    if (!ownBin) return
    reapOrphansOnPort(
      this.port,
      (info) => (process.platform === 'win32' ? /sd-server/i.test(info) : info.includes(ownBin)),
      'sd-server'
    )
  }
}

export const sdServer = new SdServerService()
